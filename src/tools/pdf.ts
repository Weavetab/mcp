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
import { hideWeaveTabOverlay, restoreWeaveTabOverlay } from "../cdp/helpers.js";

export interface PdfOptions {
  landscape?: boolean;
  scale?: number;
  pageRanges?: string;
  filename?: string;
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

  const { data } = await session.Page.printToPDF({
    landscape: options.landscape ?? false,
    scale: options.scale ?? 1.0,
    pageRanges: options.pageRanges ?? "",
    marginTop: 0.4,    // 1cm ish
    marginBottom: 0.4,
    marginLeft: 0.4,
    marginRight: 0.4,
    printBackground: true
  });

  if (shouldHide) {
    await restoreWeaveTabOverlay(session);
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
