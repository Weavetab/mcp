/**
 * Weavetab — tools/screenshot.ts
 * browser_screenshot: Capture the current tab as a base64 PNG using Page.captureScreenshot.
 *
 * Use this tool when you need pixel-level vision of the page — e.g. to verify a visual
 * result, read text in images, inspect canvas content, or confirm UI state that the DOM
 * tree cannot describe. Returns a data URL the AI can interpret visually by default.
 *
 * Do NOT use this as a replacement for browser_map — use browser_map first to interact
 * with elements. Use browser_screenshot only when visual confirmation is needed.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import fs from "node:fs";
import path from "node:path";
import { hideWeaveTabOverlay, restoreWeaveTabOverlay, maskSecretFieldsForCapture, restoreSecretFieldsAfterCapture } from "../cdp/helpers.js";

export interface ScreenshotOptions {
  /** Capture format — "png" (lossless) or "jpeg" (smaller). Default: "png". */
  format?: "png" | "jpeg";
  /** JPEG quality 0–100. Only used when format is "jpeg". Default: 90. */
  quality?: number;
  /** If true, captures the full scrollable page, not just the viewport. Default: false. */
  fullPage?: boolean;
  /** Clip region {x, y, width, height, scale}. Overrides fullPage if set. */
  clip?: { x: number; y: number; width: number; height: number };
  /** CSS selector of an element — capture is cropped to its bounding rect. */
  selector?: string;
  /** If false, keeps the WeaveTab UI overlay visible during capture.
   * Default: true — overlay is always hidden from agent captures. */
  hideOverlay?: boolean;
}

export type ScreenshotResult = {
  success: true;
  dataUrl: string;
  width: number;
  height: number;
  format: string;
};

export async function browserScreenshot(
  session: CDP.Client,
  options: ScreenshotOptions = {},
  _config: Config
): Promise<ScreenshotResult> {
  const format = options.format ?? "png";
  const quality = format === "jpeg" ? (options.quality ?? 90) : undefined;

  // Get viewport dimensions
  const { result: vpResult } = await session.Runtime.evaluate({
    expression: `JSON.stringify({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 })`,
    returnByValue: true,
  });
  const vp = JSON.parse(vpResult.value as string) as { w: number; h: number; dpr: number };

  let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined;
  let beyondViewport = !!options.fullPage;

  if (options.clip) {
    clip = { ...options.clip, scale: 1 };
  } else if (options.selector) {
    const { result: selResult } = await session.Runtime.evaluate({
      expression: `(() => {
        try {
          const el = document.querySelector(${JSON.stringify(options.selector)});
          if (!el) return JSON.stringify({ notFound: true });
          const r = el.getBoundingClientRect();
          return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height, docX: r.x + window.scrollX, docY: r.y + window.scrollY });
        } catch (e) {
          return JSON.stringify({ error: String(e && e.message || e) });
        }
      })()`,
      returnByValue: true,
    });
    const sel = selResult?.value ? JSON.parse(selResult.value as string) : { notFound: true };
    if (sel.error) {
      throw new Error(`browser_screenshot selector failed: ${sel.error}`);
    }
    if (sel.notFound || !selResult?.value) {
      throw new Error(`browser_screenshot: no element found for selector '${options.selector}'`);
    }
    if (sel.width === 0 || sel.height === 0) {
      throw new Error(`browser_screenshot: element matched by '${options.selector}' has no size (display: none or not laid out)`);
    }
    clip = { x: sel.docX, y: sel.docY, width: sel.width, height: sel.height, scale: 1 };
    beyondViewport = true;
  } else if (options.fullPage) {
    const { result: scrollResult } = await session.Runtime.evaluate({
      expression: `JSON.stringify({ 
        w: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), 
        h: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) 
      })`,
      returnByValue: true,
    });
    const scroll = scrollResult?.value ? JSON.parse(scrollResult.value as string) : { w: vp.w, h: vp.h };
    clip = { x: 0, y: 0, width: scroll.w, height: scroll.h, scale: 1 };
  }

  // ── Auto-compress: if viewport is wide, downscale to 1280px wide as JPEG 75% ──
  // This cuts token cost by 40-60% with no quality loss for text content.
  // Only applies when no explicit format/clip was requested.
  const params: any = { format, captureBeyondViewport: beyondViewport };
  if (!options.clip && !options.format && vp.w > 1280) {
    const scale = 1280 / vp.w;
    params.format = 'jpeg';
    params.quality = 75;
    params.clip = clip ?? { x: 0, y: 0, width: vp.w, height: vp.h, scale };
    if (params.clip && params.clip.scale === 1) {
      params.clip = { ...params.clip, scale };
    }
  } else {
    if (quality !== undefined) params.quality = quality;
    if (clip) params.clip = clip;
  }

  // ── AI-blind: hide Weavetab overlay elements and mask secrets before screenshot ─
  // The chat panel, ghost cursor, thought bubble, HUD iframe, and all scripted
  // UI are FOR THE USER only. Secret values are masked to prevent visual leaks.
  const shouldHide = options.hideOverlay !== false;
  if (shouldHide) {
    await hideWeaveTabOverlay(session);
  }
  await maskSecretFieldsForCapture(session);

  let data: string;
  try {
    try {
      const res = await session.Page.captureScreenshot(params);
      data = res.data;
    } catch (e) {
      if (params.captureBeyondViewport) {
        params.captureBeyondViewport = false;
        delete params.clip;
        const res = await session.Page.captureScreenshot(params);
        data = res.data;
      } else {
        throw e;
      }
    }
    const MAX_BASE64 = 2 * 1024 * 1024;
    for (const q of [70, 40]) {
      if (data.length <= MAX_BASE64) break;
      if (params.format === "jpeg" && (params.quality ?? 90) <= q) break;
      params.format = "jpeg";
      params.quality = q;
      const res = await session.Page.captureScreenshot(params);
      data = res.data;
    }
    if (data.length > MAX_BASE64) {
      throw new Error(`Screenshot payload exceeds the 2MB MCP size limit even at JPEG quality 40. Narrow the capture with clip or selector.`);
    }
  } finally {
    // Restore secret fields and overlay visibility immediately after capture
    await restoreSecretFieldsAfterCapture(session);
    if (shouldHide) {
      await restoreWeaveTabOverlay(session);
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  const width = clip ? clip.width : vp.w;
  const height = clip ? clip.height : vp.h;
  const actualFormat = params.format || format;

  const dataUrl = `data:image/${actualFormat};base64,${data}`;
  return { success: true, dataUrl, width, height, format: actualFormat };
}
