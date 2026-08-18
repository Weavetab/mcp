/**
 * Weavetab — intelligence/vision.ts
 * Local pixel-analysis visual fallback — runs when CDP AX tree returns 0 elements.
 * No external APIs. No ML. Pure image analysis using sharp.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";

export interface ClickableZone {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualFallback {
  page_state: "loading" | "blank" | "content" | "error_page";
  text_density: number;       // 0–100 (% of viewport with text-like pixels)
  content_heatmap: string;    // 4x4 grid: "X" = content present, "." = empty
  clickable_zones: ClickableZone[];
}

/**
 * Capture a CDP screenshot, run local pixel analysis, and return
 * structured signal the agent can use when the AX tree is empty.
 */
export async function analyzeVisualFallback(
  session: CDP.Client
): Promise<VisualFallback> {
  // ── 1. Capture screenshot via CDP ─────────────────────────────────────────
  const { data } = await session.Page.captureScreenshot({ format: "png" });
  const buffer = Buffer.from(data, "base64");

  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default as any;
  } catch {
    // sharp not available — return a default fallback
    return {
      page_state: "content",
      text_density: 50,
      content_heatmap: "................",
      clickable_zones: [],
    };
  }

  const img = (sharp as any)(buffer);
  const { width = 1280, height = 720 } = await img.metadata();

  // ── 2A. Raw pixels for analysis ────────────────────────────────────────────
  const rawBuf: Buffer = await img
    .raw()
    .toBuffer();

  const pixels = rawBuf; // [R, G, B, R, G, B ...]  (no alpha after .raw())
  const totalPixels = width * height;

  function getPixel(x: number, y: number): [number, number, number] {
    const idx = (y * width + x) * 3;
    return [pixels[idx]!, pixels[idx + 1]!, pixels[idx + 2]!];
  }

  // ── 2B. Convert to grayscale array ─────────────────────────────────────────
  const gray = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const r = pixels[i * 3]!;
    const g = pixels[i * 3 + 1]!;
    const b = pixels[i * 3 + 2]!;
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  // ── 3A. Dominant color regions (4×4 grid) ──────────────────────────────────
  const GRID_COLS = 4;
  const GRID_ROWS = 4;
  const cellW = Math.floor(width / GRID_COLS);
  const cellH = Math.floor(height / GRID_ROWS);

  type CellAvg = { r: number; g: number; b: number };
  const cellAvgs: CellAvg[] = [];

  for (let row = 0; row < GRID_ROWS; row++) {
    for (let col = 0; col < GRID_COLS; col++) {
      let sumR = 0, sumG = 0, sumB = 0, count = 0;
      for (let y = row * cellH; y < (row + 1) * cellH && y < height; y++) {
        for (let x = col * cellW; x < (col + 1) * cellW && x < width; x++) {
          const [r, g, b] = getPixel(x, y);
          sumR += r; sumG += g; sumB += b; count++;
        }
      }
      cellAvgs.push({ r: sumR / count, g: sumG / count, b: sumB / count });
    }
  }

  // Mark cells with significant variation from neighbors
  function colorDist(a: CellAvg, b: CellAvg): number {
    return Math.sqrt(
      (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2
    );
  }

  const heatmap = cellAvgs.map((cell, idx) => {
    const neighbors: CellAvg[] = [];
    if (idx % GRID_COLS !== 0) neighbors.push(cellAvgs[idx - 1]!);
    if (idx % GRID_COLS !== GRID_COLS - 1) neighbors.push(cellAvgs[idx + 1]!);
    if (idx >= GRID_COLS) neighbors.push(cellAvgs[idx - GRID_COLS]!);
    if (idx < cellAvgs.length - GRID_COLS) neighbors.push(cellAvgs[idx + GRID_COLS]!);
    const avgDist = neighbors.reduce((s, n) => s + colorDist(cell, n), 0) / (neighbors.length || 1);
    return avgDist > 30 ? "X" : ".";
  });
  const content_heatmap = heatmap.join("");

  // ── 3B. Text density estimate ───────────────────────────────────────────────
  let textLikePixels = 0;
  for (let i = 0; i < gray.length; i++) {
    const g = gray[i]!;
    if (g >= 40 && g <= 180) textLikePixels++;
  }
  const text_density = Math.round((textLikePixels / totalPixels) * 100);

  // ── 3C. Loading / page state detection ─────────────────────────────────────
  // Check if most pixels are the same brightness (solid color = loading screen)
  let mean = 0;
  for (let i = 0; i < gray.length; i++) mean += gray[i]!;
  mean /= gray.length;

  let variance = 0;
  for (let i = 0; i < gray.length; i++) variance += (gray[i]! - mean) ** 2;
  variance /= gray.length;
  const stdDev = Math.sqrt(variance);

  let page_state: VisualFallback["page_state"];
  if (stdDev < 10) {
    // Almost solid color
    page_state = mean > 240 ? "blank" : "loading";
  } else if (text_density < 5 && heatmap.filter((c) => c === "X").length < 3) {
    page_state = "loading";
  } else if (text_density > 15) {
    page_state = "content";
  } else {
    page_state = "content";
  }

  // Check for error page heuristic: very bright + low text density
  if (mean > 230 && text_density < 8 && stdDev < 20) {
    page_state = "error_page";
  }

  // ── 3D. Clickable zone detection ───────────────────────────────────────────
  // Scan for rectangular high-contrast bordered regions (buttons have edges).
  // Strategy: find horizontal bands of high contrast as potential button tops/bottoms.
  const clickable_zones: ClickableZone[] = [];
  const ZONE_SAMPLE_STEP = 24;

  for (let y = ZONE_SAMPLE_STEP; y < height - ZONE_SAMPLE_STEP && clickable_zones.length < 5; y += ZONE_SAMPLE_STEP) {
    for (let x = ZONE_SAMPLE_STEP; x < width - ZONE_SAMPLE_STEP; x += ZONE_SAMPLE_STEP) {
      // Sample a 3x3 neighborhood and look for high local contrast
      const center = gray[y * width + x] ?? 128;
      const neighbors = [
        gray[(y - 1) * width + x] ?? center,
        gray[(y + 1) * width + x] ?? center,
        gray[y * width + (x - 1)] ?? center,
        gray[y * width + (x + 1)] ?? center,
      ];
      const maxDiff = Math.max(...neighbors.map((n) => Math.abs(n - center)));

      // High contrast border detected — plausible button region
      if (maxDiff > 60) {
        // Check it's not too close to an existing zone
        const tooClose = clickable_zones.some(
          (z) => Math.abs(z.x - x) < 60 && Math.abs(z.y - y) < 40
        );
        if (!tooClose) {
          clickable_zones.push({ x, y, width: 80, height: 32 });
        }
      }
    }
  }

  return { page_state, text_density, content_heatmap, clickable_zones };
}
