import CDP from "chrome-remote-interface";

export interface ClickableZone {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualFallback {
  page_state: "loading" | "blank" | "content" | "error_page";
  text_density: number;
  content_heatmap: string;
  clickable_zones: ClickableZone[];
}

export async function analyzeVisualFallback(
  session: CDP.Client
): Promise<VisualFallback> {
  const { data } = await session.Page.captureScreenshot({ format: "png" });
  const buffer = Buffer.from(data, "base64");

  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default as any;
  } catch {
    return {
      page_state: "content",
      text_density: 50,
      content_heatmap: "................",
      clickable_zones: [],
    };
  }

  const img = (sharp as any)(buffer);
  const meta = (await img.metadata?.().catch(() => ({}))) ?? {};

  const pipeline = typeof img.removeAlpha === "function" ? img.removeAlpha().raw() : img.raw();
  const resolved = await pipeline.toBuffer({ resolveWithObject: true });

  const pixels: Buffer = Buffer.isBuffer(resolved) ? resolved : resolved.data;
  const width: number = resolved?.info?.width ?? meta.width ?? 1280;
  const height: number = resolved?.info?.height ?? meta.height ?? 720;
  const channels: number =
    resolved?.info?.channels ?? (pixels.length === width * height * 4 ? 4 : 3);

  const totalPixels = Math.max(1, width * height);

  function getPixel(x: number, y: number): [number, number, number] {
    const idx = (y * width + x) * channels;
    return [pixels[idx] ?? 0, pixels[idx + 1] ?? 0, pixels[idx + 2] ?? 0];
  }

  const gray = new Uint8Array(totalPixels);
  for (let i = 0; i < totalPixels; i++) {
    const base = i * channels;
    const r = pixels[base] ?? 0;
    const g = pixels[base + 1] ?? 0;
    const b = pixels[base + 2] ?? 0;
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }

  const GRID_COLS = 4;
  const GRID_ROWS = 4;
  const cellW = Math.max(1, Math.floor(width / GRID_COLS));
  const cellH = Math.max(1, Math.floor(height / GRID_ROWS));

  type CellAvg = { r: number; g: number; b: number };
  const cellAvgs: CellAvg[] = [];

  if (width >= GRID_COLS && height >= GRID_ROWS && cellW >= 1 && cellH >= 1) {
    for (let row = 0; row < GRID_ROWS; row++) {
      for (let col = 0; col < GRID_COLS; col++) {
        let sumR = 0, sumG = 0, sumB = 0, count = 0;
        for (let y = row * cellH; y < (row + 1) * cellH && y < height; y++) {
          for (let x = col * cellW; x < (col + 1) * cellW && x < width; x++) {
            const [r, g, b] = getPixel(x, y);
            sumR += r;
            sumG += g;
            sumB += b;
            count++;
          }
        }
        const denom = count || 1;
        cellAvgs.push({ r: sumR / denom, g: sumG / denom, b: sumB / denom });
      }
    }
  } else {
    for (let i = 0; i < GRID_COLS * GRID_ROWS; i++) {
      cellAvgs.push({ r: 0, g: 0, b: 0 });
    }
  }

  function colorDist(a: CellAvg, b: CellAvg): number {
    return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
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

  let textLikePixels = 0;
  for (let i = 0; i < gray.length; i++) {
    const g = gray[i]!;
    if (g >= 40 && g <= 180) textLikePixels++;
  }
  const text_density = Math.round((textLikePixels / totalPixels) * 100);

  let mean = 0;
  for (let i = 0; i < gray.length; i++) mean += gray[i]!;
  mean /= gray.length;

  let variance = 0;
  for (let i = 0; i < gray.length; i++) variance += (gray[i]! - mean) ** 2;
  variance /= gray.length;
  const stdDev = Math.sqrt(variance);

  let page_state: VisualFallback["page_state"];
  if (stdDev < 10) {
    page_state = mean > 240 ? "blank" : "loading";
  } else if (mean > 230 && text_density < 8 && stdDev < 20) {
    page_state = "error_page";
  } else if (text_density < 5 && heatmap.filter((c) => c === "X").length < 3) {
    page_state = "loading";
  } else {
    page_state = "content";
  }

  const clickable_zones: ClickableZone[] = [];
  const ZONE_SAMPLE_STEP = 24;

  for (
    let y = ZONE_SAMPLE_STEP;
    y < height - ZONE_SAMPLE_STEP && clickable_zones.length < 5;
    y += ZONE_SAMPLE_STEP
  ) {
    for (
      let x = ZONE_SAMPLE_STEP;
      x < width - ZONE_SAMPLE_STEP && clickable_zones.length < 5;
      x += ZONE_SAMPLE_STEP
    ) {
      const center = gray[y * width + x] ?? 128;
      const neighbors = [
        gray[(y - 1) * width + x] ?? center,
        gray[(y + 1) * width + x] ?? center,
        gray[y * width + (x - 1)] ?? center,
        gray[y * width + (x + 1)] ?? center,
      ];
      const maxDiff = Math.max(...neighbors.map((n) => Math.abs(n - center)));

      if (maxDiff > 60) {
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
