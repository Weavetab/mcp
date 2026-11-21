/**
 * Weavetab — tools/console.ts
 * browser_console: Buffer last 50 console entries and exception events.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { SessionSecretTracker } from "../security/secrets.js";

export interface ConsoleEntry {
  type: string;
  text: string;
  timestamp: number;
  url?: string;
}

/**
 * Server-side noise filter (Q4 decision).
 * Suppresses Weavetab-internal log spam before it enters the agent-visible buffer.
 * Extension-side gating is the long-term fix (when ext-dist/ is rebuilt), but
 * this filter acts as a reliable safety net for any messages that escape.
 *
 * Pattern matching is case-insensitive substring. Keep the list minimal.
 */
const NOISE_PATTERNS: RegExp[] = [
  /Weavetab_GROUP_STATE/i,       // Extension broadcast: idle/busy state changes
  /cursor host missing/i,        // Extension watchdog: fires every 5s on some pages
  /feedback panel missing/i,     // Extension watchdog: harmless recovery notice
  /\[Weavetab\] Cursor host/i,   // Same watchdog, alternate prefix
  /wt-cursor-trail/i,            // Extension CSS transition noise
  /__wt_push_analytics/i,        // Analytics ping echo (already fire-and-forget)
];

/** Dedup: suppress the same message within this window (ms) */
const DEDUP_WINDOW_MS = 10_000;

function isNoise(text: string): boolean {
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

const consoleBuffers = new Map<string, ConsoleEntry[]>();
/** Per-tab last-seen text for deduplication */
const lastSeenText = new Map<string, { text: string; at: number }>();

const MAX_LOG_ENTRY_LEN = 1000;

export function cleanupConsoleBuffer(targetId: string): void {
  consoleBuffers.delete(targetId);
  lastSeenText.delete(targetId);
}

export function initConsoleBuffering(session: CDP.Client, targetId: string) {
  if (consoleBuffers.has(targetId)) return;
  const buffer: ConsoleEntry[] = [];
  consoleBuffers.set(targetId, buffer);

  const push = (entry: ConsoleEntry) => {
    if (isNoise(entry.text)) return;

    const last = lastSeenText.get(targetId);
    if (last && last.text === entry.text && Date.now() - last.at < DEDUP_WINDOW_MS) return;
    lastSeenText.set(targetId, { text: entry.text, at: Date.now() });

    buffer.push(entry);
    if (buffer.length > 50) buffer.shift();
  };

  session.Runtime.on("consoleAPICalled", (event) => {
    const text = event.args.map((a: any) => (a.value !== undefined ? String(a.value) : (a.description ?? ""))).join(" ");
    push({ type: event.type, text, timestamp: event.timestamp });
  });

  session.Runtime.on("exceptionThrown", (event) => {
    push({ 
      type: "exception", 
      text: event.exceptionDetails.text + (event.exceptionDetails.exception?.description || ""),
      timestamp: event.timestamp,
      url: event.exceptionDetails.url
    });
  });

  // Clear the per-tab buffer when the MAIN frame navigates to a new document,
  // so site A's logs don't leak into site B's console reads.
  session.Page.on("frameNavigated", (event: any) => {
    const frame = event.frame;
    if (frame && !frame.parentId) {
      const buf = consoleBuffers.get(targetId);
      if (buf) buf.length = 0;
      lastSeenText.delete(targetId);
    }
  });
}

export interface ConsoleOptions {
  action: "read" | "clear";
}

export async function browserConsole(
  session: CDP.Client,
  options: ConsoleOptions,
  _config: Config,
  targetId: string
): Promise<{ success: boolean; logs: ConsoleEntry[] }> {
  
  if (options.action === "clear") {
    await session.Runtime.evaluate({
      expression: `if (window.__consoleBuffer) { window.__consoleBuffer.length = 0; window.__consoleCursor = 0; }`
    }).catch(() => {});
    const buf = consoleBuffers.get(targetId);
    if (buf) buf.length = 0;
    return { success: true, logs: [] };
  }

  const res = await session.Runtime.evaluate({
    expression: `window.__Weavetab_readConsole({ since: 'last' })`,
    returnByValue: true
  }).catch(() => null);

  let logs: any[] = [];
  if (Array.isArray(res?.result?.value)) {
    logs = res.result.value
      .map((l: any) => ({
        type: l.level,
        text: l.text,
        timestamp: l.time
      }))
      .filter((l: any) => typeof l.text !== "string" || !isNoise(l.text));
  } else {
    const buf = consoleBuffers.get(targetId);
    if (buf) {
      logs = [...buf];
      buf.length = 0;
    }
  }

  const redactedLogs = logs.map(l => {
    if (typeof l.text !== 'string') return l;
    const clean = SessionSecretTracker.redact(targetId, l.text);
    const text = clean.length > MAX_LOG_ENTRY_LEN ? `${clean.slice(0, MAX_LOG_ENTRY_LEN)}... (truncated)` : clean;
    return { ...l, text };
  });

  return { success: true, logs: redactedLogs };
}
