/**
 * Weavetab — audit/telemetry.ts
 * UDP IPC for broadcasting live telemetry to the CLI dashboard without breaking stdio MCP.
 * Also tracks tool usage analytics locally (Phase 10g).
 * Weavetab by fy2ne
 */

import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { getSystemDir } from "../config/loader.js";

const TELEMETRY_PORT = 9223;
const STATS_FILE = path.join(os.homedir(), ".weavetab-system", "stats.json");
let udpSocket: dgram.Socket | null = null;

// Generate or load telemetry secret for authentication
const TELEMETRY_SECRET_FILE = path.join(os.homedir(), ".weavetab-system", "telemetry-secret");
let telemetrySecret: string;

function getTelemetrySecret(): string {
  if (telemetrySecret) return telemetrySecret;
  
  try {
    if (fs.existsSync(TELEMETRY_SECRET_FILE)) {
      telemetrySecret = fs.readFileSync(TELEMETRY_SECRET_FILE, "utf-8").trim();
    } else {
      telemetrySecret = crypto.randomBytes(32).toString("hex");
      const dir = path.dirname(TELEMETRY_SECRET_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(TELEMETRY_SECRET_FILE, telemetrySecret, { mode: 0o600 });
    }
  } catch {
    telemetrySecret = crypto.randomBytes(32).toString("hex");
  }
  
  return telemetrySecret;
}

export interface TelemetryEvent {
  type: "log" | "state" | "browser" | "tool_start" | "tool_end" | "chat";
  timestamp: number;
  payload: any;
}

export interface ToolUsageEntry {
  tool: string;
  domain: string;
  duration: number;
  success: boolean;
  timestamp: string;
}

export interface ToolUsageStats {
  totalCalls: number;
  perTool: Record<string, { calls: number; failures: number; avgDurationMs: number }>;
  perDomain: Record<string, { calls: number; failures: number }>;
  recentEntries: ToolUsageEntry[];
}

let statsCache: ToolUsageStats | null = null;

function loadStats(): ToolUsageStats {
  if (statsCache) return statsCache;
  try {
    const data = fs.readFileSync(STATS_FILE, "utf-8");
    statsCache = JSON.parse(data) as ToolUsageStats;
    return statsCache;
  } catch {
    statsCache = {
      totalCalls: 0,
      perTool: {},
      perDomain: {},
      recentEntries: [],
    };
    return statsCache;
  }
}

let statsDirty = false;
let saveStatsTimer: ReturnType<typeof setTimeout> | null = null;

function saveStats(): void {
  if (!statsCache) return;
  // Mark as dirty and schedule an async flush at most once per 5 seconds.
  // Previously this was a synchronous writeFileSync on every tool call,
  // blocking the event loop. Now we batch writes to avoid that overhead.
  statsDirty = true;
  if (!saveStatsTimer) {
    saveStatsTimer = setTimeout(() => {
      saveStatsTimer = null;
      if (!statsDirty || !statsCache) return;
      statsDirty = false;
      const dir = path.dirname(STATS_FILE);
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const data = JSON.stringify(statsCache, null, 2);
        fs.writeFile(STATS_FILE, data, () => { /* async — ignore errors */ });
      } catch { /* ignore */ }
    }, 5000);
    // Allow the timer to not prevent process exit
    saveStatsTimer.unref?.();
  }
}

// Flush remaining dirty stats synchronously on exit so no data is lost
process.on("exit", () => {
  if (!statsDirty || !statsCache) return;
  try {
    const dir = path.dirname(STATS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATS_FILE, JSON.stringify(statsCache, null, 2));
  } catch { /* ignore */ }
});

export function recordToolUsage(entry: ToolUsageEntry): void {
  const s = loadStats();
  s.totalCalls++;

  if (!s.perTool[entry.tool]) s.perTool[entry.tool] = { calls: 0, failures: 0, avgDurationMs: 0 };
  const t = s.perTool[entry.tool];
  t.calls++;
  if (!entry.success) t.failures++;
  t.avgDurationMs = Math.round((t.avgDurationMs * (t.calls - 1) + entry.duration) / t.calls);

  const domain = entry.domain || "(unknown)";
  if (!s.perDomain[domain]) s.perDomain[domain] = { calls: 0, failures: 0 };
  s.perDomain[domain].calls++;
  if (!entry.success) s.perDomain[domain].failures++;

  s.recentEntries.unshift(entry);
  if (s.recentEntries.length > 1000) s.recentEntries.length = 1000;

  saveStats();
}

export function getToolUsageStats(): ToolUsageStats {
  return loadStats();
}

export function clearToolUsageStats(): void {
  statsCache = {
    totalCalls: 0,
    perTool: {},
    perDomain: {},
    recentEntries: [],
  };
  saveStats();
}

/** Broadcast a telemetry event to any listening dashboard (wb run) */
export function broadcastTelemetry(event: Omit<TelemetryEvent, "timestamp">): void {
  if (!udpSocket) {
    try {
      udpSocket = dgram.createSocket("udp4");
      // Prevent the socket from keeping the process alive
      udpSocket.unref();
    } catch {
      return;
    }
  }

  const fullEvent: TelemetryEvent = {
    ...event,
    timestamp: Date.now()
  };

  try {
    const secret = getTelemetrySecret();
    const payload = JSON.stringify(fullEvent);
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    
    const message = {
      sig: signature,
      payload: payload
    };
    
    const msg = Buffer.from(JSON.stringify(message) + "\n");
    udpSocket.send(msg, 0, msg.length, TELEMETRY_PORT, "127.0.0.1", (err) => {
      // Ignore broadcast errors (e.g. no dashboard listening)
    });
  } catch {
    // Ignore stringify/send errors
  }
}
