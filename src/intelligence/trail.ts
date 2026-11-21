import { logDebug } from "../audit/logger.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { SessionSecretTracker } from "../security/secrets.js";

export type TrailEntry = {
  sessionId: string;
  timestamp: string;
  tool: string;
  url?: string;
  tabId?: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
};

const SESSION_ID = crypto.randomUUID();
const MAX_LOOP_RESETS = 200;

let trail: TrailEntry[] = [];
const loopResets = new Map<string, string>();

const SESSIONS_DIR = path.join(os.homedir(), ".weavetab-system", "sessions");
const CONTEXT_FILE = path.join(SESSIONS_DIR, "context.json");

function redactPayload<T>(val: T, sessionId?: string): T {
  if (val == null) return val;
  const bySession = sessionId ? SessionSecretTracker.redactValue(sessionId, val) : val;
  if (typeof bySession === "string") {
    return SessionSecretTracker.redactAll(bySession) as T;
  }
  if (Array.isArray(bySession)) {
    return bySession.map((item) => redactPayload(item, sessionId)) as T;
  }
  if (typeof bySession === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bySession as Record<string, unknown>)) {
      out[k] = redactPayload(v, sessionId);
    }
    return out as T;
  }
  return bySession;
}

function writeContextAtomic(data: TrailEntry[]): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  const payload = JSON.stringify(data, null, 2);
  const tmp = `${CONTEXT_FILE}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, payload, "utf-8");
  try {
    fs.renameSync(tmp, CONTEXT_FILE);
  } catch {
    fs.writeFileSync(CONTEXT_FILE, payload, "utf-8");
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

try {
  if (fs.existsSync(CONTEXT_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(CONTEXT_FILE, "utf-8"));
    trail = Array.isArray(loaded) ? loaded : [];
  }
} catch {}

export function recordAction(entry: Omit<TrailEntry, "sessionId">): void {
  const sid = entry.tabId || SESSION_ID;
  const fullEntry: TrailEntry = {
    ...entry,
    sessionId: SESSION_ID,
    url: entry.url ? redactPayload(entry.url, sid) : entry.url,
    input: redactPayload(entry.input, sid),
    result: redactPayload(entry.result, sid),
  };
  trail.push(fullEntry);
  if (trail.length > 20) trail.shift();

  try {
    writeContextAtomic(trail);
  } catch (e) {
    logDebug("[Weavetab] Failed to save session context", e);
  }
}

export function getLastAction(): TrailEntry | null {
  return trail.length > 0 ? trail[trail.length - 1]! : null;
}

export function getTrail(): TrailEntry[] {
  return [...trail];
}

export function clearTrail(): void {
  trail = [];
  try {
    if (fs.existsSync(CONTEXT_FILE)) {
      writeContextAtomic([]);
    }
  } catch {}
}

const LOOP_LIMIT = 10;

export interface LoopDiagnostics {
  looped: boolean;
  strikes: number;
  severity: "none" | "warning" | "critical";
}

function setLoopReset(key: string, ts: string): void {
  if (!loopResets.has(key) && loopResets.size >= MAX_LOOP_RESETS) {
    const oldest = loopResets.keys().next().value;
    if (oldest !== undefined) loopResets.delete(oldest);
  }
  loopResets.set(key, ts);
}

export function detectLoop(tool: string, ref: string, tabId?: string): boolean {
  const resetAt =
    (tabId ? loopResets.get(`${tabId}:${tool}:${ref}`) : undefined) ??
    loopResets.get(`${tool}:${ref}`) ??
    loopResets.get("__global__");

  const sessionEntries = trail.filter(
    (e) => e.sessionId === SESSION_ID && (!resetAt || e.timestamp > resetAt)
  );
  if (sessionEntries.length < LOOP_LIMIT) return false;

  const targetTabId = tabId ?? sessionEntries[sessionEntries.length - 1]?.tabId;
  const relevant =
    targetTabId !== undefined
      ? sessionEntries.filter((e) => e.tabId === targetTabId)
      : sessionEntries;

  if (relevant.length < LOOP_LIMIT) return false;
  const lastN = relevant.slice(-LOOP_LIMIT);
  return lastN.every(
    (entry) =>
      entry.tool === tool &&
      entry.input.ref === ref &&
      (entry.result?.success === false || entry.result?.stuck === true)
  );
}

export function getLoopDiagnostics(tool: string, ref: string, tabId?: string): LoopDiagnostics {
  const resetAt =
    (tabId ? loopResets.get(`${tabId}:${tool}:${ref}`) : undefined) ??
    loopResets.get(`${tool}:${ref}`) ??
    loopResets.get("__global__");

  const targetTabId = tabId ?? (trail.length > 0 ? trail[trail.length - 1]?.tabId : undefined);
  let strikes = 0;

  for (let i = trail.length - 1; i >= 0; i--) {
    const entry = trail[i]!;
    if (entry.sessionId !== SESSION_ID) break;
    if (resetAt && entry.timestamp <= resetAt) break;
    if (targetTabId !== undefined && entry.tabId !== targetTabId) continue;
    if (
      entry.tool === tool &&
      entry.input.ref === ref &&
      (entry.result?.success === false || entry.result?.stuck === true)
    ) {
      strikes++;
    } else {
      break;
    }
  }

  let severity: LoopDiagnostics["severity"] = "none";
  if (strikes >= LOOP_LIMIT) severity = "critical";
  else if (strikes >= Math.ceil(LOOP_LIMIT / 2)) severity = "warning";
  return { looped: strikes >= LOOP_LIMIT, strikes, severity };
}

export function resetLoopCounter(reason = "manual"): void {
  loopResets.clear();
  setLoopReset("__global__", new Date().toISOString());
  toolCallWindow.length = 0;
  logDebug(`[Weavetab] Loop counter reset (reason: ${reason})`);
}

export function resetLoopCounterForRef(tool: string, ref: string, tabId?: string): void {
  const ts = new Date().toISOString();
  setLoopReset(`${tool}:${ref}`, ts);
  if (tabId) {
    setLoopReset(`${tabId}:${tool}:${ref}`, ts);
  }
  logDebug(`[Weavetab] Loop counter reset for ${tool}:${ref}`);
}

export interface ToolCallTracking {
  tool: string;
  target: string;
  timestamp: string;
  result: Record<string, unknown>;
}

const toolCallWindow: ToolCallTracking[] = [];
const MAX_WINDOW_SIZE = 6;

export function trackToolCall(tool: string, target: string, result: Record<string, unknown>): void {
  toolCallWindow.push({
    tool,
    target,
    timestamp: new Date().toISOString(),
    result: redactPayload(result),
  });

  if (toolCallWindow.length > MAX_WINDOW_SIZE) {
    toolCallWindow.shift();
  }
}

export function detectStuckLoop(): { stuck: boolean; diagnosis?: string } {
  if (toolCallWindow.length < 3) {
    return { stuck: false };
  }

  const lastCall = toolCallWindow[toolCallWindow.length - 1]!;
  const lastState = JSON.stringify(lastCall.result);
  let consecutiveCount = 1;

  for (let i = toolCallWindow.length - 2; i >= 0; i--) {
    const call = toolCallWindow[i]!;
    if (
      call.tool === lastCall.tool &&
      call.target === lastCall.target &&
      JSON.stringify(call.result) === lastState
    ) {
      consecutiveCount++;
    } else {
      break;
    }
  }

  if (consecutiveCount >= 3) {
    return {
      stuck: true,
      diagnosis: `Agent is stuck in a loop: ${consecutiveCount} consecutive calls to ${lastCall.tool} on target "${lastCall.target}" without state change. Consider trying a different approach or resetting the loop counter.`,
    };
  }

  return { stuck: false };
}

export function clearToolCallWindow(): void {
  toolCallWindow.length = 0;
}

export function getToolCallWindow(): ToolCallTracking[] {
  return [...toolCallWindow];
}

export function detectCrossToolLoop(): { stuck: boolean; pattern?: string; diagnosis?: string } {
  if (toolCallWindow.length < 4) return { stuck: false };

  const recent = toolCallWindow.slice(-6);
  const tools = recent.map((c) => c.tool);
  const allFailed = recent.every((c) => c.result?.success === false || c.result?.stuck === true);

  if (!allFailed) return { stuck: false };

  if (recent.length >= 4) {
    const last4Tools = tools.slice(-4);
    if (
      last4Tools[0] === last4Tools[2] &&
      last4Tools[1] === last4Tools[3] &&
      last4Tools[0] !== last4Tools[1]
    ) {
      const pattern = `${last4Tools[0]} → ${last4Tools[1]}`;
      return {
        stuck: true,
        pattern,
        diagnosis: `Cross-tool loop detected: cycling "${pattern}" (${recent.length} times) without success. Stop this approach entirely. Try: 1) browser_map() to re-read the page, 2) browser_screenshot() to see what's visible, 3) browser_captcha({action:"detect"}) if a CAPTCHA may be blocking.`,
      };
    }
  }

  if (recent.length >= 6) {
    const last6Tools = tools.slice(-6);
    if (
      last6Tools[0] === last6Tools[3] &&
      last6Tools[1] === last6Tools[4] &&
      last6Tools[2] === last6Tools[5]
    ) {
      const pattern = `${last6Tools[0]} → ${last6Tools[1]} → ${last6Tools[2]}`;
      return {
        stuck: true,
        pattern,
        diagnosis: `Cross-tool loop detected: cycling "${pattern}" without success. Stop and reassess. Call browser_map() to re-read the page state.`,
      };
    }
  }

  return { stuck: false };
}
