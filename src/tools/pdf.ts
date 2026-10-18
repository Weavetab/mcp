/**
 * Weavetab — tools/pdf.ts
 * browser_pdf: Generate a PDF of the current page.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getOutputDir } from "../config/loader.js";
import fs from "node:fs";
import path from "node:path";
import { hideWeaveTabOverlay, restoreWeaveTabOverlay, maskSecretFieldsForCapture, restoreSecretFieldsAfterCapture } from "../cdp/helpers.js";

export interface PdfMargins {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
}

export interface PdfOptions {
  landscape?: boolean;
  scale?: number;
  pageRanges?: string;
  filename?: string;
  /** Page margin in inches — a number (all sides) or per-side object.
   * Default: 0.4 on every side. */
  margin?: number | PdfMargins;
  /** If false, keeps the WeaveTab UI overlay visible in the PDF.
   * Default: true — overlay (cursor, thought bubble, HUD) is always hidden from PDFs. */
  hideOverlay?: boolean;
}

export async function browserPdf(
  session: CDP.Client,
  options: PdfOptions,
  config: Config
): Promise<{ success: boolean; path: string; size: string; filename: string }> {
  
  // Always hide the overlay before generating PDF (agent must never see it).
  // Set hideOverlay: false explicitly to keep overlays visible.
  const shouldHide = options.hideOverlay !== false;
  if (shouldHide) {
    await hideWeaveTabOverlay(session);
  }
  await maskSecretFieldsForCapture(session);

  let data: string;
  const margins: PdfMargins =
    typeof options.margin === "number"
      ? { top: options.margin, bottom: options.margin, left: options.margin, right: options.margin }
      : (options.margin ?? {});
  try {
    const pdfRes = await session.Page.printToPDF({
      landscape: options.landscape ?? false,
      scale: options.scale ?? 1.0,
      pageRanges: options.pageRanges ?? "",
      marginTop: margins.top ?? 0.4,    // 1cm ish
      marginBottom: margins.bottom ?? 0.4,
      marginLeft: margins.left ?? 0.4,
      marginRight: margins.right ?? 0.4,
      printBackground: true
    });
    data = pdfRes.data;
  } finally {
    await restoreSecretFieldsAfterCapture(session);
    if (shouldHide) {
      await restoreWeaveTabOverlay(session);
    }
  }

  // Use configured PDF directory or default
  const pdfsDir = getOutputDir("pdfs", config);
  if (!fs.existsSync(pdfsDir)) {
    fs.mkdirSync(pdfsDir, { recursive: true });
  }

  // Strip directory components from the filename (path traversal prevention).
  // Mirrors snapshot.ts:42 which already uses path.basename correctly.
  const rawName = options.filename || `capture_${Date.now()}.pdf`;
  const filename = path.basename(rawName);
  const fullPath = path.join(pdfsDir, filename);
  
  fs.writeFileSync(fullPath, Buffer.from(data, 'base64'));

  return { 
    success: true, 
    path: fullPath, 
    size: `${(Buffer.from(data, 'base64').length / 1024).toFixed(1)} KB`,
    filename
  };
}
