/**
 * Weavetab — audit/logger.ts
 * Appends structured action records to ~/.weavetab-system/logs/mission_<timestamp>.log and JSON lines to mission_<timestamp>.jsonl.
 * Only writes logs when devMode is true to prevent storage spam.
 * Weavetab by fy2ne
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { broadcastTelemetry } from "./telemetry.js";
import { getSystemDir, getCachedConfig, loadConfigSync } from "../config/loader.js";
import { SessionSecretTracker } from "../security/secrets.js";

// Mission logs always go to the system dir (~/.weavetab-system/logs)
// to avoid polluting user workspaces with large log files.
const missionId = new Date().toISOString().replace(/[:.]/g, "-");
function getLogDir() { return getSystemDir("logs"); }
function getLogPath() { return path.join(getLogDir(), `mission_${missionId}.log`); }
function getJsonLogPath() { return path.join(getLogDir(), `mission_${missionId}.jsonl`); }

// Check if logging should be enabled based on devMode
let _isCheckingConfig = false;
function isLoggingEnabled(): boolean {
  if (_isCheckingConfig) return false;
  try {
    _isCheckingConfig = true;
    const config = getCachedConfig();
    return config ? (config.devMode || false) : false;
  } catch {
    return false; // Fail safe - no logging if config can't be read
  } finally {
    _isCheckingConfig = false;
  }
}

// Redact sensitive data patterns from logs
function redactSensitiveData(text: string): string {
  if (!text || typeof text !== 'string') return text;
  
  let redacted = text;
  
  // Redact common secret patterns
  const patterns = [
    // API keys, tokens, secrets in URLs
    /([?&](api_key|token|secret|password|credential|auth|access_token|refresh_token)=[^&\s]+)/gi,
    // Bearer tokens
    /(Bearer\s+[A-Za-z0-9\-._~+/]+)/gi,
    // Basic auth in URLs
    /(\/\/[^:]+:[^@]+@)/g,
    // UUIDs that might be tokens
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    // Long alphanumeric strings that might be keys (30+ chars)
    /\b[A-Za-z0-9+/]{30,}={0,2}\b/g,
  ];
  
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, (match) => {
      // Keep the parameter name but redact the value
      if (match.includes('=')) {
        const [key, value] = match.split('=');
        return `${key}=[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  
  return redacted;
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

// ─── Async buffered log writer ─────────────────────────────────────────────────
// Previously logAction() called appendFileSync on every tool call, blocking the
// event loop. Now lines are queued and flushed asynchronously on a short debounce.

interface LogBuffer {
  lines: string[];
  timer: ReturnType<typeof setTimeout> | null;
}

const plainBuffer: LogBuffer = { lines: [], timer: null };
const jsonBuffer: LogBuffer = { lines: [], timer: null };

function scheduleFlush(buffer: LogBuffer, filePath: string): void {
  if (buffer.timer) return; // already scheduled
  buffer.timer = setTimeout(() => {
    buffer.timer = null;
    if (buffer.lines.length === 0) return;
    const chunk = buffer.lines.join("");
    buffer.lines = [];
    fs.appendFile(filePath, chunk, () => { /* async — ignore errors */ });
  }, 100);
  buffer.timer.unref?.();
}

// On exit, flush remaining buffered lines synchronously so no log is lost
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
  } catch { /* ignore — best-effort */ }
});

export function logAction(action: string, target: string, result: string): void {
  try {
    // Redact sensitive data before logging
    // Use a session-agnostic redaction for general logs (no specific session ID)
    const redactedTarget = redactSensitiveData(target);
    const redactedResult = redactSensitiveData(result);
    
    // Always broadcast telemetry (separate from file logging)
    broadcastTelemetry({ type: "log", payload: { action, target: redactedTarget, result: redactedResult } });

    // Only write to log files if devMode is enabled
    if (!isLoggingEnabled()) {
      return;
    }

    const timestamp = new Date().toISOString();
    const paddedAction = action.padEnd(10);
    const line = `[${timestamp}]  ${paddedAction}  ${redactedTarget}  →  ${redactedResult}\n`;
    // Ensure the log directory exists (only if we're about to write the first line)
    if (plainBuffer.lines.length === 0) {
      const dir = getLogDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
    // Redact sensitive data before logging
    const redactedEntry: AuditEntry = {
      ...entry,
      parameters: entry.parameters ? redactSensitiveDataInObject(entry.parameters) : undefined,
      pageUrl: entry.pageUrl ? redactSensitiveData(entry.pageUrl) : undefined,
      result: entry.result ? redactSensitiveData(entry.result) : "",
    };
    
    // Only write to log files if devMode is enabled
    if (!isLoggingEnabled()) {
      return;
    }

    const line = JSON.stringify(redactedEntry) + "\n";
    if (jsonBuffer.lines.length === 0) {
      const dir = getLogDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    jsonBuffer.lines.push(line);
    scheduleFlush(jsonBuffer, getJsonLogPath());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[!] Weave warning: Failed to write structured audit log: ${msg}\n`);
  }
}

// Recursively redact sensitive data in objects
function redactSensitiveDataInObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = redactSensitiveData(value);
    } else if (typeof value === 'object' && value !== null) {
      result[key] = redactSensitiveDataInObject(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

export function logDebug(message: string | any, ...optionalParams: any[]): void {
  if (!isLoggingEnabled()) return;
  process.stderr.write(`${message} ${optionalParams.join(' ')}\n`);
}
