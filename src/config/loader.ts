import { logDebug } from "../audit/logger.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export type DevModeConfig = boolean;

export type PolicyMode = "allow" | "deny" | "audit-only" | "read-only";
export type Role = "admin" | "operator" | "viewer" | "automation" | "system";
export type BrowserEngine = "chromium" | "firefox" | "webkit";

export interface PolicyEntry {
  pattern: string;
  mode: PolicyMode;
}

export interface ElectronAppConfig {
  path?: string;
  port?: number;
  url?: string;
  args?: string[];
  profileDir?: string;
}

export interface Config {
  mode: "session" | "attach";
  session: string;
  attachPort: number;
  agentId: string;
  telemetry: boolean;

  browserPath: string;
  browserType: BrowserEngine;
  headless: boolean;
  extension: boolean;
  browserFlags: string[];
  profileDir: string;
  cookies: boolean;
  syncDataAcrossBrowsers: boolean;

  apps?: Record<string, ElectronAppConfig>;
  electron?: Record<string, ElectronAppConfig>;

  role: Role;
  block: string[];
  allow: string[];
  policies: PolicyEntry[];

  sessionTimeout: number;
  navigationTimeout: number;
  idleTimeout: number;
  actionabilityTimeoutMs: number;
  maxTabs: number;
  maxActionsPerMinute: number;
  refCacheTtlMs: number;

  downloadDir: string;
  pdfDir: string;
  snapshotDir: string;
  recordingDir: string;

  devMode: DevModeConfig;

  proxy?: string;
}

export const PLATFORM = os.platform();

const HOME = os.homedir();
const lowerGlobal = path.join(HOME, ".weavetab");
const upperGlobal = path.join(HOME, ".Weavetab");
export const GLOBAL_CONFIG_DIR = fs.existsSync(lowerGlobal) ? lowerGlobal : (fs.existsSync(upperGlobal) ? upperGlobal : lowerGlobal);
export const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, "config.json");

export const DEFAULT_CONFIG: Config = {
  mode: "session",
  session: "default",
  attachPort: 0,
  agentId: process.env.WT_AGENT_ID || crypto.randomUUID(),
  telemetry: false,

  browserPath: "auto",
  browserType: "chromium",
  headless: false,
  extension: true,
  browserFlags: [],
  profileDir: "",
  cookies: false,
  syncDataAcrossBrowsers: false,

  apps: undefined,
  electron: undefined,

  role: "operator",
  block: ["*.bank.*", "paypal.com"],
  allow: [],
  policies: [],

  sessionTimeout: 3600,
  navigationTimeout: 30000,
  idleTimeout: 60000,
  actionabilityTimeoutMs: 300,
  maxTabs: 10,
  maxActionsPerMinute: 60,
  refCacheTtlMs: 30_000,

  downloadDir: "",
  pdfDir: "",
  snapshotDir: "",
  recordingDir: "",

  devMode: false,

  proxy: undefined,
};

export type OnConfigChange = (newConfig: Config) => void;
const listeners: OnConfigChange[] = [];

export function onConfigChange(cb: OnConfigChange): () => void {
  listeners.push(cb);
  return () => {
    const idx = listeners.indexOf(cb);
    if (idx !== -1) listeners.splice(idx, 1);
  };
}

function ensureConfigDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function isSectionedConfig(raw: Record<string, unknown>): boolean {
  return "general" in raw || "browser" in raw || "security" in raw || "performance" in raw;
}

export function migrateToSimple(sectioned: any): Config {
  return {
    mode: sectioned.general?.mode || "session",
    session: sectioned.general?.session || "default",
    attachPort: sectioned.general?.attachPort || 0,
    agentId: sectioned.general?.agentId || crypto.randomUUID(),
    telemetry: sectioned.general?.telemetry || false,

    browserPath: sectioned.browser?.path || "auto",
    browserType: sectioned.browser?.type || "chromium",
    headless: sectioned.browser?.headless ?? false,
    extension: sectioned.browser?.extension ?? sectioned.browser?.visuals ?? true,
    browserFlags: sectioned.browser?.flags || [],
    profileDir: sectioned.browser?.profileDir || "",
    cookies: sectioned.browser?.cookies || false,

    apps: sectioned.apps || sectioned.electron || undefined,
    electron: sectioned.apps || sectioned.electron || undefined,

    role: sectioned.security?.role || "operator",
    block: sectioned.security?.block || ["*.bank.*", "paypal.com"],
    allow: sectioned.security?.allow || [],
    policies: sectioned.security?.policies || [],

    sessionTimeout: sectioned.performance?.timeouts?.session || 3600,
    navigationTimeout: sectioned.performance?.timeouts?.navigation || 30000,
    idleTimeout: sectioned.performance?.timeouts?.idle || 60000,
    actionabilityTimeoutMs: sectioned.performance?.timeouts?.actionability || 300,
    maxTabs: sectioned.performance?.limits?.maxTabs || 10,
    maxActionsPerMinute: sectioned.performance?.limits?.maxActionsPerMinute || 60,
    refCacheTtlMs: sectioned.performance?.cache?.refCacheTtlMs || 30_000,

    downloadDir: sectioned.paths?.downloads || "",
    pdfDir: sectioned.paths?.pdfs || "",
    snapshotDir: sectioned.paths?.snapshots || "",
    recordingDir: sectioned.paths?.recordings || "",

    devMode: typeof sectioned.devMode === "boolean" ? sectioned.devMode : sectioned.devMode?.enabled || false,

    syncDataAcrossBrowsers: sectioned.general?.syncDataAcrossBrowsers || false,

    proxy: sectioned.network?.proxy,
  };
}

function validateField<T>(
  fieldName: string,
  value: unknown,
  check: (v: unknown) => v is T,
  defaultValue: T,
  extra?: (v: T) => boolean
): T {
  if (!check(value)) {
    logDebug(`[Weavetab Config] [WARN] Invalid type for "${fieldName}" (got ${typeof value}). Resetting to default.`);
    return defaultValue;
  }
  if (extra && !extra(value)) {
    logDebug(`[Weavetab Config] [WARN] Out-of-range value for "${fieldName}" (got ${JSON.stringify(value)}). Resetting to default.`);
    return defaultValue;
  }
  return value;
}

const isStr  = (v: unknown): v is string    => typeof v === "string";
const isBool = (v: unknown): v is boolean   => typeof v === "boolean";
const isNum  = (v: unknown): v is number    => typeof v === "number" && isFinite(v);
const isArr  = (v: unknown): v is unknown[] => Array.isArray(v);

const VALID_POLICY_MODES = ["allow", "deny", "read-only", "audit-only", "audit"] as const;

function validatePolicies(rawPolicies: unknown): PolicyEntry[] {
  if (!Array.isArray(rawPolicies)) return DEFAULT_CONFIG.policies;
  const out: PolicyEntry[] = [];
  for (const p of rawPolicies) {
    if (
      p &&
      typeof p === "object" &&
      typeof (p as any).pattern === "string" &&
      (p as any).pattern.trim().length > 0 &&
      (VALID_POLICY_MODES as readonly string[]).includes((p as any).mode)
    ) {
      const normalizedMode: PolicyMode = (p as any).mode === "audit" ? "audit-only" : (p as any).mode;
      out.push({
        pattern: (p as any).pattern.trim(),
        mode: normalizedMode,
      });
    } else {
      logDebug(`[Weavetab Config] [WARN] Skipping invalid policy entry: ${JSON.stringify(p)}`);
    }
  }
  return out;
}

function writeAtomicJson(targetPath: string, data: unknown): void {
  const dir = path.dirname(targetPath);
  ensureConfigDir(dir);
  const tmpFile = path.join(dir, `config.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}.json`);
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpFile, targetPath);
  } catch (e) {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    throw e;
  }
}

function validateConfig(raw: Record<string, unknown>): Config {
  if (isSectionedConfig(raw)) {
    logDebug("[Weavetab Config] [INFO] Detected old sectioned config format, migrating to simplified structure...");
    const migrated = migrateToSimple(raw);
    const validated = validateConfigInternal(migrated as unknown as Record<string, unknown>);
    try {
      writeAtomicJson(GLOBAL_CONFIG_PATH, validated);
      logDebug(`[Weavetab Config] [OK] Migrated config saved to ${GLOBAL_CONFIG_PATH}`);
    } catch (e) {
      logDebug("[Weavetab Config] [WARN] Failed to save migrated config:", e);
    }
    return validated;
  }

  return validateConfigInternal(raw);
}

export function validateConfigInternal(raw: Record<string, unknown>): Config {
  const d = DEFAULT_CONFIG;
  const VALID_MODES   = ["session", "attach"] as const;
  const VALID_ENGINES = ["chromium", "firefox", "webkit"] as const;
  const VALID_ROLES   = ["admin", "operator", "viewer", "automation", "system"] as const;
  const mode = validateField("mode", raw.mode, isStr, d.mode, v => (VALID_MODES as readonly string[]).includes(v)) as Config["mode"];

  function safePathField(field: string, value: unknown): string {
    if (!isStr(value) || !value.trim()) return "";
    const trimmed = value.trim();
    const segments = trimmed.split(/[\\/]/);
    if (segments.includes("..") || trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
      logDebug(`[Weavetab Config] [WARN] Suspicious path in "${field}": "${trimmed}". Resetting to default.`);
      return "";
    }
    return path.resolve(trimmed);
  }

  const rawDownloadDir = safePathField("downloadDir", raw.downloadDir);
  let downloadDir = rawDownloadDir;
  if (downloadDir) {
    if (!fs.existsSync(downloadDir)) {
      try {
        fs.mkdirSync(downloadDir, { recursive: true });
        logDebug(`[Weavetab Config] [OK] Created custom download directory: ${downloadDir}`);
      } catch {
        logDebug(`[Weavetab Config] [ERROR] Failed to create downloadDir "${downloadDir}". Resetting to default.`);
        downloadDir = "";
      }
    }
  }

  const rawBrowser = validateField("browserPath", raw.browserPath ?? "auto", isStr, d.browserPath);
  let browserPath = rawBrowser;
  if (browserPath && browserPath !== "auto") {
    if ((browserPath.includes("/") || browserPath.includes("\\")) && !fs.existsSync(browserPath)) {
      logDebug(`[Weavetab Config] [WARN] browser path "${browserPath}" does not exist. Resetting to "auto".`);
      browserPath = "auto";
    }
  }

  const profileDir = safePathField("profileDir", raw.profileDir);

  let proxy: string | undefined;
  const rawProxy = isStr(raw.proxy) ? raw.proxy.trim() : "";
  if (rawProxy && rawProxy !== "$WT_PROXY_URL") {
    if (/:\/\/[^:]+:[^@]+@/.test(rawProxy)) {
      logDebug(`[Weavetab Config] [WARN] Proxy contains literal credentials (://user:pass@). This is a security risk. Use an environment variable instead. Ignoring proxy.`);
      proxy = undefined;
    } else {
      proxy = rawProxy;
    }
  } else if (rawProxy === "$WT_PROXY_URL" || (!rawProxy && process.env.WT_PROXY_URL)) {
    proxy = process.env.WT_PROXY_URL;
  }

  let electron: Record<string, ElectronAppConfig> | undefined = undefined;
  const appSources = [raw.electron, raw.apps].filter(
    (src): src is Record<string, unknown> => Boolean(src && typeof src === "object" && !Array.isArray(src))
  );
  if (appSources.length > 0) {
    const validatedMap: Record<string, ElectronAppConfig> = {};
    for (const rawMap of appSources) {
      for (const [rawKey, rawVal] of Object.entries(rawMap)) {
        const sanitizedKey = rawKey.trim();
        if (!/^[a-zA-Z0-9_-]+$/.test(sanitizedKey)) {
          logDebug(`[Weavetab Config] [WARN] Invalid app name "${rawKey}". Must be alphanumeric, dashes, or underscores.`);
          continue;
        }
        let parsedCfg: ElectronAppConfig | null = null;
        if (typeof rawVal === "string") {
          const strVal = rawVal.trim();
          if (!strVal || strVal.toLowerCase() === "auto") {
            logDebug(`[Weavetab Config] [WARN] Skipping placeholder path "${strVal}" for app "${sanitizedKey}".`);
            continue;
          } else if (/^\d+$/.test(strVal)) {
            const portNum = parseInt(strVal, 10);
            if (portNum > 0 && portNum <= 65535) parsedCfg = { port: portNum };
          } else if (strVal.startsWith("http://") || strVal.startsWith("https://") || strVal.startsWith("ws://") || strVal.startsWith("wss://")) {
            parsedCfg = { url: strVal };
            try {
              const parsedUrl = new URL(strVal);
              if (parsedUrl.port) {
                const p = parseInt(parsedUrl.port, 10);
                if (p > 0 && p <= 65535) parsedCfg.port = p;
              }
            } catch { /* ignore */ }
          } else {
            const safePath = safePathField(`apps.${sanitizedKey}`, strVal);
            if (safePath) parsedCfg = { path: safePath };
          }
        } else if (typeof rawVal === "number" && Number.isFinite(rawVal) && rawVal > 0 && rawVal <= 65535) {
          parsedCfg = { port: rawVal };
        } else if (typeof rawVal === "object" && rawVal !== null && !Array.isArray(rawVal)) {
          const objVal = rawVal as Record<string, unknown>;
          const appCfg: ElectronAppConfig = {};
          if (typeof objVal.path === "string" && objVal.path.trim() && objVal.path.trim().toLowerCase() !== "auto") {
            const safePath = safePathField(`apps.${sanitizedKey}.path`, objVal.path);
            if (safePath) appCfg.path = safePath;
          }
          if (typeof objVal.port === "number" && Number.isFinite(objVal.port) && objVal.port > 0 && objVal.port <= 65535) {
            appCfg.port = objVal.port;
          } else if (typeof objVal.port === "string" && /^\d+$/.test((objVal.port as string).trim())) {
            const p = parseInt((objVal.port as string).trim(), 10);
            if (p > 0 && p <= 65535) appCfg.port = p;
          }
          if (typeof objVal.url === "string" && objVal.url.trim()) {
            appCfg.url = objVal.url.trim();
          }
          if (Array.isArray(objVal.args)) {
            appCfg.args = (objVal.args as unknown[]).filter(isStr);
          }
          if (typeof objVal.profileDir === "string" && objVal.profileDir.trim()) {
            appCfg.profileDir = safePathField(`apps.${sanitizedKey}.profileDir`, objVal.profileDir);
          }
          if (appCfg.path || appCfg.port || appCfg.url || appCfg.profileDir || (appCfg.args && appCfg.args.length > 0)) {
            parsedCfg = appCfg;
          }
        }
        if (parsedCfg) {
          validatedMap[sanitizedKey] = { ...(validatedMap[sanitizedKey] || {}), ...parsedCfg };
        }
      }
    }
    if (Object.keys(validatedMap).length > 0) {
      electron = validatedMap;
    }
  }

  return {
    mode,
    session:                validateField("session", raw.session, isStr, d.session),
    attachPort:             mode !== "attach" ? 0 : validateField("attachPort", raw.attachPort, isNum, d.attachPort, v => v >= 0 && v <= 65535),
    agentId:                isStr(raw.agentId) ? raw.agentId : d.agentId,
    telemetry:              validateField("telemetry", raw.telemetry, isBool, d.telemetry),

    browserPath,
    browserType:            validateField("browserType", raw.browserType, isStr, d.browserType, v => (VALID_ENGINES as readonly string[]).includes(v)) as BrowserEngine,
    headless:               validateField("headless", raw.headless, isBool, d.headless),
    extension:              validateField("extension", raw.extension, isBool, d.extension),
    browserFlags:           isArr(raw.browserFlags) ? (raw.browserFlags as unknown[]).filter(isStr) : d.browserFlags,
    profileDir,
    cookies:                validateField("cookies", raw.cookies, isBool, d.cookies),

    apps:                   electron,
    electron,

    role:                   validateField("role", raw.role, isStr, d.role, v => (VALID_ROLES as readonly string[]).includes(v)) as Role,
    block:                  isArr(raw.block) ? (raw.block as unknown[]).filter(isStr) : d.block,
    allow:                  isArr(raw.allow) ? (raw.allow as unknown[]).filter(isStr) : d.allow,
    policies:               validatePolicies(raw.policies),

    sessionTimeout:         validateField("sessionTimeout", raw.sessionTimeout, isNum, d.sessionTimeout, v => v >= 60 && v <= 86400),
    navigationTimeout:      validateField("navigationTimeout", raw.navigationTimeout, isNum, d.navigationTimeout, v => v >= 1000 && v <= 120000),
    idleTimeout:            validateField("idleTimeout", raw.idleTimeout, isNum, d.idleTimeout, v => v >= 5000),
    actionabilityTimeoutMs: validateField("actionabilityTimeoutMs", raw.actionabilityTimeoutMs, isNum, d.actionabilityTimeoutMs, v => v >= 50 && v <= 15000),
    maxTabs:                validateField("maxTabs", raw.maxTabs, isNum, d.maxTabs, v => v >= 1 && v <= 100),
    maxActionsPerMinute:    validateField("maxActionsPerMinute", raw.maxActionsPerMinute, isNum, d.maxActionsPerMinute, v => v >= 1 && v <= 600),
    refCacheTtlMs:          validateField("refCacheTtlMs", raw.refCacheTtlMs, isNum, d.refCacheTtlMs, v => v >= 1000 && v <= 300_000),

    downloadDir,
    pdfDir:                 safePathField("pdfDir", raw.pdfDir),
    snapshotDir:            safePathField("snapshotDir", raw.snapshotDir),
    recordingDir:           safePathField("recordingDir", raw.recordingDir),

    devMode:                isBool(raw.devMode) ? raw.devMode : d.devMode,

    syncDataAcrossBrowsers: validateField("syncDataAcrossBrowsers", raw.syncDataAcrossBrowsers, isBool, d.syncDataAcrossBrowsers),

    proxy:                  isStr(proxy) ? proxy : d.proxy,
  };
}

type ReadResult =
  | { status: "ok";      data: Record<string, unknown>; file: string }
  | { status: "missing"; file: string }
  | { status: "broken";  file: string };

export function safeReadJson(file: string): ReadResult {
  if (!fs.existsSync(file)) return { status: "missing", file };
  try {
    const raw = fs.readFileSync(file, "utf-8").trim();
    if (!raw) return { status: "missing", file };

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      const fixed = raw.replace(/"([a-zA-Z]:\\[^"]*)"/g, (_match, p1) => {
        const normalized = p1.replace(/\\\\/g, "\\").replace(/\\/g, "\\\\");
        return `"${normalized}"`;
      });
      data = JSON.parse(fixed);
    }

    if (typeof data !== "object" || Array.isArray(data) || data === null) {
      return { status: "broken", file };
    }
    return { status: "ok", data: data as Record<string, unknown>, file };
  } catch {
    return { status: "broken", file };
  }
}

const _lastQuarantine = new Map<string, number>();
const QUARANTINE_COOLDOWN_MS = 5_000;

function quarantineBrokenConfig(file: string): void {
  const now = Date.now();
  const last = _lastQuarantine.get(file) || 0;
  if (now - last < QUARANTINE_COOLDOWN_MS) return;
  _lastQuarantine.set(file, now);

  const dir  = path.dirname(file);
  const name = `config.broken.${Date.now()}.json`;
  const dest = path.join(dir, name);
  try {
    fs.renameSync(file, dest);
    logDebug(`[Weavetab Config] [WARN] Broken config quarantined → ${dest}`);

    const brokenFiles = fs.readdirSync(dir)
      .filter(f => f.startsWith("config.broken.") && f.endsWith(".json"))
      .map(f => ({ name: f, time: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time);

    if (brokenFiles.length > 5) {
      brokenFiles.slice(5).forEach(f => {
        try { fs.unlinkSync(path.join(dir, f.name)); } catch { /* ignore */ }
      });
    }
  } catch {
    logDebug(`[Weavetab Config] [ERROR] Could not quarantine broken config at ${file}`);
  }
}

function resolveConfigMerge(): { config: Config; activeDir: string } {
  const globalDir  = GLOBAL_CONFIG_DIR;
  const globalFile = GLOBAL_CONFIG_PATH;

  ensureConfigDir(globalDir);

  const globalResult = safeReadJson(globalFile);

  if (globalResult.status === "broken") {
    logDebug(`[Weavetab Config] [ERROR] Global config at "${globalFile}" is broken JSON!`);
    quarantineBrokenConfig(globalFile);
  }

  const hasGlobal = globalResult.status === "ok";
  const activeDir = globalDir;

  if (hasGlobal) {
    logDebug(`[Weavetab Config] [OK] Using global config: ${globalFile}`);
    logDebug(`[Weavetab Config] [OK] Active directory: ${activeDir}`);
  } else {
    logDebug(`[Weavetab Config] [WARN] No config found — using built-in defaults. Run: weavetab config`);
    logDebug(`[Weavetab Config] [OK] Active directory: ${activeDir}`);
    ensureConfigDir(globalDir);
    if (!fs.existsSync(globalFile)) {
      try {
        writeAtomicJson(globalFile, DEFAULT_CONFIG);
        logDebug(`[Weavetab Config] [OK] Created starter config at: ${globalFile}`);
      } catch { /* non-fatal */ }
    }
  }

  const globalData = hasGlobal ? (globalResult as { status: "ok"; data: Record<string, unknown>; file: string }).data : {};
  const merged: Record<string, unknown> = {
    ...(DEFAULT_CONFIG as unknown as Record<string, unknown>),
    ...globalData,
  };

  const config = validateConfig(merged);

  const dirDefaults: [keyof Config, string][] = [
    ["downloadDir", "downloads"],
    ["pdfDir", "pdfs"],
    ["snapshotDir", "snapshots"],
    ["recordingDir", "recordings"],
  ];
  for (const [field, subdir] of dirDefaults) {
    if (!config[field]) {
      (config as any)[field] = path.join(activeDir, subdir);
    }
  }

  return { config, activeDir };
}

function cleanupBrokenConfigs(): void {
  try {
    const files = fs.readdirSync(GLOBAL_CONFIG_DIR);
    let cleaned = 0;
    for (const f of files) {
      if ((f.startsWith("config.broken.") && f.endsWith(".json")) || f.startsWith("config.tmp.")) {
        try {
          fs.unlinkSync(path.join(GLOBAL_CONFIG_DIR, f));
          cleaned++;
        } catch { /* ignore */ }
      }
    }
    if (cleaned > 0) {
      logDebug(`[Weavetab Config] [OK] Cleaned up ${cleaned} stale broken/temp config file(s)`);
    }
  } catch { /* ignore */ }
}

export function getActiveConfigPath(): { dir: string; file: string } {
  return { dir: GLOBAL_CONFIG_DIR, file: GLOBAL_CONFIG_PATH };
}

let _cachedConfig: Config | null = null;
let _cachedActiveDir: string | null = null;

export function loadConfigSync(): Config {
  cleanupBrokenConfigs();
  const { config, activeDir } = resolveConfigMerge();
  _cachedConfig    = config;
  _cachedActiveDir = activeDir;
  return config;
}

export async function loadConfig(): Promise<Config> {
  _cachedConfig = loadConfigSync();
  return _cachedConfig;
}

export function getCachedConfig(): Config {
  if (!_cachedConfig) _cachedConfig = loadConfigSync();
  return _cachedConfig;
}

export function invalidateConfigCache(): void {
  _cachedConfig = null;
  _cachedActiveDir = null;
}

export function getActiveDirCached(): string {
  if (!_cachedActiveDir) loadConfigSync();
  return _cachedActiveDir ?? GLOBAL_CONFIG_DIR;
}

export function getOutputDir(subdir: "downloads" | "pdfs" | "snapshots" | "recordings", config?: Config): string {
  if (!config) {
    const dir = path.join(GLOBAL_CONFIG_DIR, subdir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  const fieldMap: Record<string, string> = {
    downloads: "downloadDir",
    pdfs: "pdfDir",
    snapshots: "snapshotDir",
    recordings: "recordingDir",
  };

  const field = fieldMap[subdir];
  const customPath = field ? (config as any)[field] : undefined;

  if (customPath && typeof customPath === "string" && customPath.trim()) {
    const resolved = customPath.trim();
    if (!fs.existsSync(resolved)) {
      try {
        fs.mkdirSync(resolved, { recursive: true });
      } catch { /* ignore */ }
    }
    return resolved;
  }

  const dir = path.join(GLOBAL_CONFIG_DIR, subdir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getDownloadDir(config: Config): string {
  return config.downloadDir || "";
}

export function getConfigMode(config: Config): "session" | "attach" {
  return config.mode;
}

export function getConfigAttachPort(config: Config): number {
  return config.attachPort;
}

export function getConfigAgentId(config: Config): string {
  return config.agentId;
}

export function getConfigTelemetry(config: Config): boolean {
  return config.telemetry;
}

export function getConfigBrowserPath(config: Config): string {
  return config.browserPath;
}

export function getConfigBrowserType(config: Config): BrowserEngine {
  return config.browserType;
}

export function getConfigHeadless(config: Config): boolean {
  return config.headless;
}

export function getConfigExtension(config: Config): boolean {
  return config.extension !== false;
}

export function getConfigBrowserFlags(config: Config): string[] {
  return config.browserFlags;
}

export function getConfigProfileDir(config: Config): string {
  return config.profileDir;
}

export function getConfigCookies(config: Config): boolean {
  return config.cookies;
}

export function getConfigSyncDataAcrossBrowsers(config: Config): boolean {
  return config.syncDataAcrossBrowsers;
}

export function getConfigRole(config: Config): Role {
  return config.role;
}

export function getConfigBlock(config: Config): string[] {
  return config.block;
}

export function getConfigAllow(config: Config): string[] {
  return config.allow;
}

export function getConfigPolicies(config: Config): PolicyEntry[] {
  return config.policies;
}

export function getConfigProxy(config: Config): string | undefined {
  return config.proxy;
}

export function getConfigMaxTabs(config: Config): number {
  return config.maxTabs;
}

export function getConfigMaxActionsPerMinute(config: Config): number {
  return config.maxActionsPerMinute;
}

export function getConfigSessionTimeout(config: Config): number {
  return config.sessionTimeout;
}

export function getConfigNavigationTimeout(config: Config): number {
  return config.navigationTimeout;
}

export function getConfigIdleTimeout(config: Config): number {
  return config.idleTimeout;
}

export function getConfigActionabilityTimeoutMs(config: Config): number {
  return config.actionabilityTimeoutMs;
}

export function getConfigRefCacheTtl(config: Config): number {
  return config.refCacheTtlMs;
}

export function getConfigDevMode(config: Config): boolean {
  return config.devMode;
}

export function getConfigApps(config: Config): Record<string, ElectronAppConfig> | undefined {
  return config.apps || config.electron;
}

export function getConfigElectron(config: Config): Record<string, ElectronAppConfig> | undefined {
  return config.apps || config.electron;
}

export function getAppConfig(appName: string, config?: Config): ElectronAppConfig | null {
  const cfg = config ?? getCachedConfig();
  const map = cfg.apps || cfg.electron;
  if (!map) return null;
  const sanitized = appName.trim();
  return map[sanitized] || null;
}

export function getElectronAppConfig(appName: string, config?: Config): ElectronAppConfig | null {
  return getAppConfig(appName, config);
}

export function getAppNames(config?: Config): string[] {
  const cfg = config ?? getCachedConfig();
  const map = cfg.apps || cfg.electron;
  if (!map) return [];
  return Object.keys(map);
}

export function getElectronAppNames(config?: Config): string[] {
  return getAppNames(config);
}

export function getApps(config?: Config): Record<string, ElectronAppConfig> {
  const cfg = config ?? getCachedConfig();
  return cfg.apps || cfg.electron || {};
}

export function getElectronApps(config?: Config): Record<string, ElectronAppConfig> {
  return getApps(config);
}

export function getConfigNavigationTimeoutMs(config: Config): number {
  return config.navigationTimeout;
}

export function getConfigRefCacheTtlMs(config: Config): number {
  return config.refCacheTtlMs;
}

const GLOBAL_SYSTEM_DIR = path.join(HOME, ".weavetab-system");

export function getSystemDir(subdir: string): string {
  const dir = path.join(GLOBAL_SYSTEM_DIR, subdir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getSystemAppDir(appName: string): string {
  const sanitized = appName.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = path.join(GLOBAL_SYSTEM_DIR, "apps", sanitized);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getGlobalSystemDir(subdir: string): string {
  const dir = path.join(GLOBAL_SYSTEM_DIR, subdir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getSystemMemorySitesDir(): string {
  const dir = path.join(GLOBAL_SYSTEM_DIR, "memory", "sites");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

let _lastSelfSaveMs = 0;

export function saveConfig(config: Config): void {
  const { dir, file } = getActiveConfigPath();
  ensureConfigDir(dir);
  const mode = getConfigMode(config);
  if (mode !== "attach") {
    config.attachPort = 0;
  }
  _lastSelfSaveMs = Date.now();
  writeAtomicJson(file, config);
  _cachedConfig = loadConfigSync();
  _lastSelfSaveMs = Date.now();
  listeners.forEach(cb => cb(_cachedConfig!));
}

let watchTimeout: NodeJS.Timeout | null = null;
let _configWatcher: fs.FSWatcher | null = null;

export function startConfigWatcher(dir: string = GLOBAL_CONFIG_DIR): void {
  try {
    ensureConfigDir(dir);
    if (_configWatcher) {
      try { _configWatcher.close(); } catch { /* ignore */ }
      _configWatcher = null;
    }
    _configWatcher = fs.watch(dir, (eventType, filename) => {
      if (filename === "config.json" && (eventType === "change" || eventType === "rename")) {
        if (Date.now() - _lastSelfSaveMs < 400) return;
        if (watchTimeout) clearTimeout(watchTimeout);
        watchTimeout = setTimeout(() => {
          if (Date.now() - _lastSelfSaveMs < 400) return;
          if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return;
          try {
            _cachedConfig = loadConfigSync();
            listeners.forEach(cb => cb(_cachedConfig!));
          } catch (e) {
            logDebug("[Weavetab] Failed to reload config", e);
          }
        }, 150);
        if (watchTimeout && typeof watchTimeout.unref === "function") {
          watchTimeout.unref();
        }
      }
    });
    _configWatcher.on("error", () => {});
    if (_configWatcher && typeof (_configWatcher as any).unref === "function") {
      (_configWatcher as any).unref();
    }
  } catch {
    // ignore watch errors
  }
}

export function stopConfigWatcher(): void {
  if (watchTimeout) {
    clearTimeout(watchTimeout);
    watchTimeout = null;
  }
  if (_configWatcher) {
    try {
      _configWatcher.close();
    } catch { /* ignore */ }
    _configWatcher = null;
  }
}
