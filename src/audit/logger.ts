import * as fs from "node:fs";
import * as path from "node:path";
import { broadcastTelemetry } from "./telemetry.js";
import { getSystemDir, getCachedConfig } from "../config/loader.js";
import { SessionSecretTracker } from "../security/secrets.js";

const missionId = new Date().toISOString().replace(/[:.]/g, "-");
function getLogDir() { return getSystemDir("logs"); }
function getLogPath() { return path.join(getLogDir(), `mission_${missionId}.log`); }
function getJsonLogPath() { return path.join(getLogDir(), `mission_${missionId}.jsonl`); }

let _isCheckingConfig = false;
function isLoggingEnabled(): boolean {
  if (_isCheckingConfig) return false;
  try {
    _isCheckingConfig = true;
    const config = getCachedConfig();
    return config ? Boolean(config.devMode) : false;
  } catch {
    return false;
  } finally {
    _isCheckingConfig = false;
  }
}

const SENSITIVE_KEY_REGEX = /password|secret|token|api[-_]?key|authorization|cookie/i;

export function redactSensitiveData(text: string): string {
  if (!text || typeof text !== "string") return text;

  let redacted = SessionSecretTracker.redactAll(text);

  const patterns = [
    /([?&](api_key|token|secret|password|credential|auth|access_token|refresh_token)=[^&\s]+)/gi,
    /(Bearer\s+[A-Za-z0-9\-._~+/]+)/gi,
    /(\/\/[^:]+:[^@]+@)/g,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    /\b[A-Za-z0-9+/]{30,}={0,2}\b/g,
  ];

  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, (match) => {
      if (match.includes("=")) {
        const eqIdx = match.indexOf("=");
        return `${match.slice(0, eqIdx)}=[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }

  return redacted;
}

export function redactSensitiveDataInObject<T = any>(
  obj: T,
  seen: WeakSet<object> = new WeakSet()
): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return redactSensitiveData(obj) as unknown as T;
  if (typeof obj !== "object") return obj;

  if (seen.has(obj as object)) return "[Circular]" as unknown as T;
  seen.add(obj as object);

  if (Array.isArray(obj)) {
    return obj.map((item) => redactSensitiveDataInObject(item, seen)) as unknown as T;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (SENSITIVE_KEY_REGEX.test(key)) {
      out[key] = "[REDACTED]";
    } else if (typeof value === "string") {
      out[key] = redactSensitiveData(value);
    } else if (typeof value === "object" && value !== null) {
      out[key] = redactSensitiveDataInObject(value, seen);
    } else {
      out[key] = value;
    }
  }

  return out as unknown as T;
}

export interface AuditEntry {
  timestamp: string;
  sessionId?: string;
  tool: string;
  parameters?: Record<string, unknown>;
  duration?: number;
  result: string;
  pageUrl?: string;
  tabTitle?: string;
}

interface LogBuffer {
  lines: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

const plainBuffer: LogBuffer = { lines: [], timer: null };
const jsonBuffer: LogBuffer = { lines: [], timer: null };
let _prunedLogs = false;

export function pruneOldLogs(dir?: string, maxFiles = 30): void {
  try {
    const targetDir = dir || getLogDir();
    if (!fs.existsSync(targetDir)) return;
    const entries = fs.readdirSync(targetDir)
      .filter((f) => f.startsWith("mission_") && (f.endsWith(".log") || f.endsWith(".jsonl")))
      .map((f) => {
        const full = path.join(targetDir, f);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { /* ignore */ }
        return { full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (entries.length > maxFiles) {
      for (const old of entries.slice(maxFiles)) {
        try { fs.unlinkSync(old.full); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

function ensureLogDirAndPrune(): void {
  const dir = getLogDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!_prunedLogs) {
    _prunedLogs = true;
    pruneOldLogs(dir, 30);
  }
}

function scheduleFlush(buffer: LogBuffer, filePath: string): void {
  if (buffer.timer) return;
  buffer.timer = setTimeout(() => {
    buffer.timer = null;
    if (buffer.lines.length === 0) return;
    const chunk = buffer.lines.join("");
    buffer.lines = [];
    fs.appendFile(filePath, chunk, () => { /* ignore */ });
  }, 100);
  buffer.timer.unref?.();
}

process.on("exit", () => {
  try {
    if (plainBuffer.lines.length > 0) {
      if (plainBuffer.timer) { clearTimeout(plainBuffer.timer); plainBuffer.timer = null; }
      fs.appendFileSync(getLogPath(), plainBuffer.lines.join(""), "utf-8");
      plainBuffer.lines = [];
    }
    if (jsonBuffer.lines.length > 0) {
      if (jsonBuffer.timer) { clearTimeout(jsonBuffer.timer); jsonBuffer.timer = null; }
      fs.appendFileSync(getJsonLogPath(), jsonBuffer.lines.join(""), "utf-8");
      jsonBuffer.lines = [];
    }
  } catch { /* ignore */ }
});

export function logAction(action: string, target: string, result: string): void {
  try {
    const redactedTarget = redactSensitiveData(target);
    const redactedResult = redactSensitiveData(result);

    broadcastTelemetry({ type: "log", payload: { action, target: redactedTarget, result: redactedResult } });

    if (!isLoggingEnabled()) {
      return;
    }

    const timestamp = new Date().toISOString();
    const paddedAction = action.padEnd(10);
    const line = `[${timestamp}]  ${paddedAction}  ${redactedTarget}  →  ${redactedResult}\n`;
    if (plainBuffer.lines.length === 0) {
      ensureLogDirAndPrune();
    }
    plainBuffer.lines.push(line);
    scheduleFlush(plainBuffer, getLogPath());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[!] Weave warning: Failed to write audit log: ${msg}\n`);
  }
}

export function logActionStructured(entry: AuditEntry): void {
  try {
    const redactedEntry: AuditEntry = {
      ...entry,
      parameters: entry.parameters ? redactSensitiveDataInObject(entry.parameters) : undefined,
      pageUrl: entry.pageUrl ? redactSensitiveData(entry.pageUrl) : undefined,
      result: entry.result ? redactSensitiveData(entry.result) : "",
    };

    if (!isLoggingEnabled()) {
      return;
    }

    const line = JSON.stringify(redactedEntry) + "\n";
    if (jsonBuffer.lines.length === 0) {
      ensureLogDirAndPrune();
    }
    jsonBuffer.lines.push(line);
    scheduleFlush(jsonBuffer, getJsonLogPath());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[!] Weave warning: Failed to write structured audit log: ${msg}\n`);
  }
}

function formatParam(p: unknown): string {
  if (p instanceof Error) return p.stack || p.message;
  if (typeof p === "string") return p;
  if (typeof p === "object" && p !== null) {
    try { return JSON.stringify(p); } catch { return String(p); }
  }
  return String(p);
}

export function logDebug(message: unknown, ...optionalParams: unknown[]): void {
  if (!isLoggingEnabled()) return;
  const head = formatParam(message);
  const tail = optionalParams.length > 0 ? " " + optionalParams.map(formatParam).join(" ") : "";
  process.stderr.write(`${head}${tail}\n`);
}
