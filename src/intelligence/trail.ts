import { logDebug } from "../audit/logger.js";
// src/intelligence/trail.ts
// Lightweight action trail — keeps last 50 actions in memory.
// Used by tools to record what happened for context and audit.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import * as crypto from "node:crypto";

export type TrailEntry = {
  sessionId: string;
  timestamp: string;
  tool: string;
  url?: string;
  tabId?: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
};

// Generate a unique session ID for this process run
const SESSION_ID = crypto.randomUUID();

let trail: TrailEntry[] = [];

// Per-ref loop reset registry.
// Maps "tool:ref" or "__global__" → ISO timestamp of the last explicit reset.
// getLoopDiagnostics / detectLoop only count trail entries recorded AFTER this timestamp.
// Trail history itself is NEVER wiped by resetLoopCounter — context is preserved.
const loopResets = new Map<string, string>();

const SESSIONS_DIR = path.join(os.homedir(), ".weavetab-system", "sessions");
const CONTEXT_FILE = path.join(SESSIONS_DIR, "context.json");

function ensureContextFile() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  if (!fs.existsSync(CONTEXT_FILE)) {
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify([]));
  }
}

try {
  if (fs.existsSync(CONTEXT_FILE)) {
    trail = JSON.parse(fs.readFileSync(CONTEXT_FILE, 'utf-8'));
  }
} catch (e) {}

export function recordAction(entry: Omit<TrailEntry, "sessionId">): void {
  const fullEntry: TrailEntry = { ...entry, sessionId: SESSION_ID };
  trail.push(fullEntry);
  // Cap at 20 entries to reduce stale cross-session disk poisoning
  if (trail.length > 20) trail.shift();
  
  try {
    ensureContextFile();
    fs.writeFileSync(CONTEXT_FILE, JSON.stringify(trail, null, 2));
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
      fs.writeFileSync(CONTEXT_FILE, JSON.stringify([]));
    }
  } catch (e) {}
}

const LOOP_LIMIT = 10;

export interface LoopDiagnostics {
  looped: boolean;
  strikes: number;
  severity: "none" | "warning" | "critical";
}

export function detectLoop(tool: string, ref: string): boolean {
  const resetAt = loopResets.get(`${tool}:${ref}`) ?? loopResets.get("__global__");
  // Only consider entries after the last reset boundary and from this session
  const relevant = trail.filter(e => e.sessionId === SESSION_ID && (!resetAt || e.timestamp > resetAt));
  if (relevant.length < LOOP_LIMIT) return false;
  const lastN = relevant.slice(-LOOP_LIMIT);
  return lastN.every(entry =>
    entry.tool === tool && entry.input.ref === ref &&
    (entry.result?.success === false || entry.result?.stuck === true)
  );
}

export function getLoopDiagnostics(tool: string, ref: string): LoopDiagnostics {
  // Per-ref reset takes priority over global reset
  const resetAt = loopResets.get(`${tool}:${ref}`) ?? loopResets.get("__global__");
  let strikes = 0;
  for (let i = trail.length - 1; i >= 0; i--) {
    const entry = trail[i]!;
    // Stop counting if we hit a different session or the reset boundary
    if (entry.sessionId !== SESSION_ID) break;
    if (resetAt && entry.timestamp <= resetAt) break;
    if (entry.tool === tool && entry.input.ref === ref &&
        (entry.result?.success === false || entry.result?.stuck === true)) {
      strikes++;
    } else break;
  }
  let severity: LoopDiagnostics["severity"] = "none";
  if (strikes >= LOOP_LIMIT) severity = "critical";
  else if (strikes >= Math.ceil(LOOP_LIMIT / 2)) severity = "warning";
  return { looped: strikes >= LOOP_LIMIT, strikes, severity };
}

export function resetLoopCounter(reason = "manual"): void {
  // Record a global reset timestamp. Loop detection ignores all trail entries
  // recorded before this moment. Trail history is intentionally preserved —
  // burst, delta, and memory all depend on it staying intact.
  loopResets.clear(); // also clears any per-ref markers
  loopResets.set("__global__", new Date().toISOString());
  // Also clear the rolling toolCallWindow — it is session-global and survives
  // navigation, causing false STUCK_LOOP bricks across different pages/tasks.
  toolCallWindow.length = 0;
  logDebug(`[Weavetab] Loop counter reset (reason: ${reason}) — trail history preserved, strike window cleared`);
}

/**
 * Reset loop detection for a single tool+ref pair only.
 * Does not affect other refs or the trail history.
 */
export function resetLoopCounterForRef(tool: string, ref: string): void {
  loopResets.set(`${tool}:${ref}`, new Date().toISOString());
  logDebug(`[Weavetab] Loop counter reset for ${tool}:${ref}`);
}


// Enhanced loop prevention with rolling window detection
export interface ToolCallTracking {
  tool: string;
  target: string;
  timestamp: string;
  result: Record<string, unknown>;
}

// Rolling window of last 5 tool calls for loop detection
const toolCallWindow: ToolCallTracking[] = [];
const MAX_WINDOW_SIZE = 5;

/**
 * Track a tool call for loop detection
 * Maintains a rolling window of the last 5 tool calls
 */
export function trackToolCall(tool: string, target: string, result: Record<string, unknown>): void {
  toolCallWindow.push({
    tool,
    target,
    timestamp: new Date().toISOString(),
    result,
  });

  // Keep only the last MAX_WINDOW_SIZE calls
  if (toolCallWindow.length > MAX_WINDOW_SIZE) {
    toolCallWindow.shift();
  }
}

/**
 * Check if the agent is stuck in a loop using rolling window detection
 * Returns STUCK signal with diagnosis if loop detected
 */
export function detectStuckLoop(): { stuck: boolean; diagnosis?: string } {
  if (toolCallWindow.length < 3) {
    return { stuck: false };
  }

  // Check for 3 consecutive same-tool+target calls without state change
  let consecutiveCount = 0;
  let lastStateChange: string | undefined;

  for (let i = toolCallWindow.length - 1; i >= 0; i--) {
    const call = toolCallWindow[i];
    const currentState = JSON.stringify(call.result);

    // Compare with previous call
    if (i > 0) {
      const prevCall = toolCallWindow[i - 1];
      if (call.tool === prevCall.tool && call.target === prevCall.target) {
        // Check if state changed
        if (currentState === lastStateChange) {
          consecutiveCount++;
        } else {
          consecutiveCount = 0;
          lastStateChange = currentState;
        }
      } else {
        consecutiveCount = 0;
        lastStateChange = currentState;
      }
    }
  }

  if (consecutiveCount >= 2) { // 3 total (current + 2 previous)
    const lastCall = toolCallWindow[toolCallWindow.length - 1];
    return {
      stuck: true,
      diagnosis: `Agent is stuck in a loop: ${consecutiveCount + 1} consecutive calls to ${lastCall.tool} on target "${lastCall.target}" without state change. Consider trying a different approach or resetting the loop counter.`
    };
  }

  return { stuck: false };
}

/**
 * Clear the tool call window (useful when starting a new task).
 * Also called by navigate.ts on every navigation to prevent cross-page STUCK_LOOP.
 */
export function clearToolCallWindow(): void {
  toolCallWindow.length = 0;
}

/**
 * Get the current tool call window (for debugging)
 */
export function getToolCallWindow(): ToolCallTracking[] {
  return [...toolCallWindow];
}

/**
 * Detect cross-tool loops — e.g. click→fill→click→fill repeating with no success.
 * Catches cases where the agent alternates between tools on the same target
 * without making progress, which single-tool detection misses entirely.
 */
export function detectCrossToolLoop(): { stuck: boolean; pattern?: string; diagnosis?: string } {
  if (toolCallWindow.length < 4) return { stuck: false };

  const recent = toolCallWindow.slice(-6); // look at last 6 calls
  const tools = recent.map(c => c.tool);
  const allFailed = recent.every(c => c.result?.success === false || c.result?.stuck === true);

  if (!allFailed) return { stuck: false };

  // Check for repeating 2-cycle pattern: A B A B or A B A B A B
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

  // Check for repeating 3-cycle: A B C A B C
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

