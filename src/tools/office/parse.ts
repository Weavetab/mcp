import CDP from "chrome-remote-interface";
import type { Config } from "../../config/loader.js";
import { getOutputDir } from "../../config/loader.js";
import fs from "fs";
import path from "path";
import { logAction, logDebug } from "../../audit/logger.js";
// @ts-ignore
import { parse as parseCsv } from "csv-parse/sync";
// @ts-ignore
import pdfParse from "pdf-parse";
// @ts-ignore
import mammoth from "mammoth";
// @ts-ignore
import * as xlsx from "xlsx";

export interface OfficeParseOptions {
  /** URL to a remote document (PDF, XLSX, DOCX, CSV). Fetched in-browser using the user's active cookies. */
  url?: string;
  /** Exact filename from the local downloads directory (legacy mode). */
  filename?: string;
  max_rows?: number;
  max_chars?: number;
}

export interface OfficeParseResult {
  success: boolean;
  source: string;
  type: string;
  content?: string;
  data?: any;
  error?: string;
  truncated?: boolean;
}

/** Fetch a URL inside the browser's context using fetch(), return base64-encoded bytes + MIME type. */
async function cdpFetchAsBase64(
  session: CDP.Client,
  url: string
): Promise<{ base64: string; mimeType: string } | { error: string }> {
  const expression = `(async () => {
    try {
      const resp = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      if (!resp.ok) return JSON.stringify({ error: 'HTTP ' + resp.status + ' ' + resp.statusText });
      const mime = resp.headers.get('content-type') || 'application/octet-stream';
      const buf = await resp.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const b64 = btoa(binary);
      return JSON.stringify({ base64: b64, mimeType: mime });
    } catch (e) {
      return JSON.stringify({ error: e.message || String(e) });
    }
  })()`;

  try {
    const { result } = await session.Runtime.evaluate({
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const raw = result?.value as string | undefined;
    if (!raw) return { error: "No response from in-browser fetch" };
    return JSON.parse(raw);
  } catch (e: any) {
    return { error: `CDP evaluate failed: ${e.message}` };
  }
}

/** Infer file extension from URL path or MIME type. */
function inferExtension(url: string, mimeType: string): string {
  // Try URL path first
  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).toLowerCase();
    if ([".pdf", ".xlsx", ".xls", ".docx", ".csv"].includes(ext)) return ext;
  } catch { /* ignore */ }

  // Fall back to MIME type
  if (mimeType.includes("pdf")) return ".pdf";
  if (mimeType.includes("spreadsheetml") || mimeType.includes("excel")) return ".xlsx";
  if (mimeType.includes("wordprocessingml") || mimeType.includes("msword")) return ".docx";
  if (mimeType.includes("csv") || mimeType.includes("text/plain")) return ".csv";
  return ".bin";
}

async function parseBuffer(
  buffer: Buffer,
  ext: string,
  source: string,
  max_rows: number,
  max_chars: number
): Promise<OfficeParseResult> {
  try {
    if (ext === ".csv") {
      const fileContent = buffer.toString("utf-8");
      const records = parseCsv(fileContent, { columns: true, skip_empty_lines: true });
      const truncated = records.length > max_rows;
      const data = truncated ? records.slice(0, max_rows) : records;
      return { success: true, source, type: "csv", data, truncated };
    }

    if (ext === ".pdf") {
      const data = await pdfParse(buffer);
      let text = data.text;
      let truncated = false;
      if (text.length > max_chars) {
        text = text.substring(0, max_chars) + "\n...[TRUNCATED]...";
        truncated = true;
      }
      return {
        success: true,
        source,
        type: "pdf",
        content: text.trim(),
        truncated,
        data: { numpages: data.numpages, info: data.info },
      };
    }

    if (ext === ".docx") {
      const result = await mammoth.extractRawText({ buffer });
      let text = result.value;
      let truncated = false;
      if (text.length > max_chars) {
        text = text.substring(0, max_chars) + "\n...[TRUNCATED]...";
        truncated = true;
      }
      const warnings = result.messages.map((m: any) => m.message);
      if (warnings.length > 0) logDebug(`[Office] Mammoth warnings: ${warnings.join(", ")}`);
      return { success: true, source, type: "docx", content: text.trim(), truncated };
    }

    if (ext === ".xlsx" || ext === ".xls") {
      const workbook = xlsx.read(buffer, { type: "buffer" });
      const resultData: Record<string, any[]> = {};
      let truncated = false;
      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const records = xlsx.utils.sheet_to_json(sheet);
        if (records.length > max_rows) {
          resultData[sheetName] = records.slice(0, max_rows);
          truncated = true;
        } else {
          resultData[sheetName] = records;
        }
      }
      return { success: true, source, type: "excel", data: resultData, truncated };
    }

    return {
      success: false,
      source,
      type: ext,
      error: `Unsupported file type: ${ext}. Supported: .csv, .pdf, .docx, .xlsx, .xls`,
    };
  } catch (error: any) {
    return { success: false, source, type: ext, error: `Failed to parse: ${error.message}` };
  }
}

export async function browserOfficeParse(
  session: CDP.Client,
  options: OfficeParseOptions,
  config: Config
): Promise<OfficeParseResult> {
  const { url, filename, max_rows = 500, max_chars = 50000 } = options;

  if (!url && !filename) {
    return { success: false, source: "", type: "unknown", error: "Provide either 'url' (remote document) or 'filename' (local download)." };
  }

  // ── URL mode: fetch in-browser via CDP Runtime.evaluate ───────────────────
  if (url) {
    logAction("browser_office_parse", "url", `Fetching ${url}`);
    const fetchResult = await cdpFetchAsBase64(session, url);
    if ("error" in fetchResult) {
      return { success: false, source: url, type: "unknown", error: `Fetch failed: ${fetchResult.error}` };
    }

    const { base64, mimeType } = fetchResult;
    const ext = inferExtension(url, mimeType);
    const buffer = Buffer.from(base64, "base64");

    logDebug(`[Office] URL fetch: ${url} → ${ext} (${buffer.length} bytes, mime=${mimeType})`);
    logAction("browser_office_parse", ext, `Parsing ${url} (${buffer.length} bytes)`);

    return parseBuffer(buffer, ext, url, max_rows, max_chars);
  }

  // ── Filename mode: legacy local file parsing ───────────────────────────────
  if (filename) {
    // Security: prevent path traversal
    if (
      filename.includes("..") ||
      filename.includes("/") ||
      filename.includes("\\") ||
      path.basename(filename) !== filename
    ) {
      return { success: false, source: filename, type: "unknown", error: "Invalid filename — must be a bare filename, not a path" };
    }

    const downloadDir = getOutputDir("downloads", config);
    const filePath = path.join(downloadDir, filename);

    if (!fs.existsSync(filePath)) {
      return { success: false, source: filename, type: "unknown", error: `File not found: ${filename}` };
    }

    const ext = path.extname(filename).toLowerCase();
    logAction("browser_office_parse", ext, `Parsing local file ${filename}`);

    const buffer = fs.readFileSync(filePath);
    return parseBuffer(buffer, ext, filename, max_rows, max_chars);
  }

  return { success: false, source: "", type: "unknown", error: "Unreachable" };
}
