import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { getCachedConfig } from "../config/loader.js";
import { applyFilePermissions, enforceFilePermissions } from "../security/secrets.js";

const TELEMETRY_PORT = 9223;
const STATS_FILE = path.join(os.homedir(), ".weavetab-system", "stats.json");
const MAX_PER_DOMAIN = 500;
let udpSocket: dgram.Socket | null = null;

const TELEMETRY_SECRET_FILE = path.join(os.homedir(), ".weavetab-system", "telemetry-secret");
let telemetrySecret: string;

function getTelemetrySecret(): string {
  if (telemetrySecret) return telemetrySecret;

  try {
    if (fs.existsSync(TELEMETRY_SECRET_FILE)) {
      enforceFilePermissions(TELEMETRY_SECRET_FILE);
      telemetrySecret = fs.readFileSync(TELEMETRY_SECRET_FILE, "utf-8").trim();
    } else {
      telemetrySecret = crypto.randomBytes(32).toString("hex");
      const dir = path.dirname(TELEMETRY_SECRET_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(TELEMETRY_SECRET_FILE, telemetrySecret, { mode: 0o600 });
      applyFilePermissions(TELEMETRY_SECRET_FILE);
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

function writeStatsSync(stats: ToolUsageStats): void {
  const dir = path.dirname(STATS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${STATS_FILE}.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(stats, null, 2), "utf-8");
    fs.renameSync(tmpFile, STATS_FILE);
  } catch {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

let statsDirty = false;
let saveStatsTimer: ReturnType<typeof setTimeout> | null = null;

function saveStats(): void {
  if (!statsCache) return;
  statsDirty = true;
  if (!saveStatsTimer) {
    saveStatsTimer = setTimeout(() => {
      saveStatsTimer = null;
      if (!statsDirty || !statsCache) return;
      statsDirty = false;
      writeStatsSync(statsCache);
    }, 5000);
    saveStatsTimer.unref?.();
  }
}

process.on("exit", () => {
  if (!statsDirty || !statsCache) return;
  statsDirty = false;
  writeStatsSync(statsCache);
});

export function recordToolUsage(entry: ToolUsageEntry): void {
  const s = loadStats();
  s.totalCalls++;

  if (!s.perTool[entry.tool]) s.perTool[entry.tool] = { calls: 0, failures: 0, avgDurationMs: 0 };
  const t = s.perTool[entry.tool]!;
  t.calls++;
  if (!entry.success) t.failures++;
  t.avgDurationMs = Math.round((t.avgDurationMs * (t.calls - 1) + entry.duration) / t.calls);

  const domain = entry.domain || "(unknown)";
  if (!Object.hasOwn(s.perDomain, domain)) {
    const keys = Object.keys(s.perDomain);
    while (keys.length >= MAX_PER_DOMAIN) {
      const oldest = keys.shift();
      if (oldest) delete s.perDomain[oldest];
    }
    s.perDomain[domain] = { calls: 0, failures: 0 };
  }
  s.perDomain[domain]!.calls++;
  if (!entry.success) s.perDomain[domain]!.failures++;

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

export function broadcastTelemetry(event: Omit<TelemetryEvent, "timestamp">): void {
  try {
    const cfg = getCachedConfig();
    if (!cfg || cfg.telemetry !== true) return;
  } catch {
    return;
  }

  if (!udpSocket) {
    try {
      udpSocket = dgram.createSocket("udp4");
      udpSocket.unref();
    } catch {
      return;
    }
  }

  const fullEvent: TelemetryEvent = {
    ...event,
    timestamp: Date.now(),
  };

  try {
    const secret = getTelemetrySecret();
    const payload = JSON.stringify(fullEvent);
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");

    const message = {
      sig: signature,
      payload,
    };

    const msg = Buffer.from(JSON.stringify(message) + "\n");
    udpSocket.send(msg, 0, msg.length, TELEMETRY_PORT, "127.0.0.1", () => {});
  } catch {
    // ignore
  }
}
