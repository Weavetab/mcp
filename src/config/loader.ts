import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — config/loader.ts
 * Enterprise-grade config resolution with multi-source merge, per-field validation,
 * broken config recovery, and real-browser isolation checks.
 * Weavetab by fy2ne
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export type DevModeConfig = boolean;

export type PolicyMode = "allow" | "deny" | "audit-only" | "read-only";
export type Role = "admin" | "viewer" | "automation" | "system";
export type BrowserEngine = "chromium" | "firefox" | "webkit";

export interface PolicyEntry {
  pattern: string;
  mode: PolicyMode;
}

// ─── Simplified Config Structure ─────────────────────────────────────────────────────

export interface Config {
  mode: "session" | "attach";
  session: string;
  attachPort: number;
  agentId: string;
  telemetry: boolean;
  
  browserPath: string;
  browserType: BrowserEngine;
  headless: boolean;
  visuals: boolean;
  darkMode: boolean;
  disableExtensions: boolean;
  browserFlags: string[];
  profileDir: string;
  cookies: boolean;
  syncDataAcrossBrowsers: boolean;
  
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
  githubCacheTtlMs: number;
  refCacheTtlMs: number;
  
  downloadDir: string;
  pdfDir: string;
  snapshotDir: string;
  recordingDir: string;
  designDir: string;
  
  devMode: DevModeConfig;
  
  proxy?: string;
}

// ─── Main Config Interface ─────────────────────────────────────────────────────────

// ─── Directory constants ───────────────────────────────────────────────────────

// Platform detection (used throughout the file)
export const PLATFORM = os.platform();

const HOME = os.homedir();
const lowerGlobal = path.join(HOME, ".weavetab");
const upperGlobal = path.join(HOME, ".Weavetab");
export const GLOBAL_CONFIG_DIR = fs.existsSync(lowerGlobal) ? lowerGlobal : (fs.existsSync(upperGlobal) ? upperGlobal : lowerGlobal);
export const GLOBAL_CONFIG_PATH = path.join(GLOBAL_CONFIG_DIR, "config.json");
const OLD_SYSTEM_PATH = path.join(GLOBAL_CONFIG_DIR, "system.json");
const OLD_UI_PATH     = path.join(GLOBAL_CONFIG_DIR, "ui_manifest.json");

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: Config = {
  mode: "session",
  session: "default",
  attachPort: 0,
  agentId: process.env.WT_AGENT_ID || crypto.randomUUID(),
  telemetry: false,
  
  browserPath: "auto",
  browserType: "chromium",
  headless: false,
  visuals: true,
  darkMode: true,
  disableExtensions: false,
  browserFlags: [],
  profileDir: "",
  cookies: false,
  syncDataAcrossBrowsers: false,
  
  role: "admin",
  block: ["*.bank.*", "paypal.com"],
  allow: [],
  policies: [],
  
  sessionTimeout: 3600,
  navigationTimeout: 30000,
  idleTimeout: 60000,
  actionabilityTimeoutMs: 15000,
  maxTabs: 10,
  maxActionsPerMinute: 60,
  githubCacheTtlMs: 30 * 60 * 1000,
  refCacheTtlMs: 30_000,
  
  downloadDir: "",
  pdfDir: "",
  snapshotDir: "",
  recordingDir: "",
  designDir: "",
  
  devMode: false,

  proxy: undefined,
};

// ─── Config change listeners ───────────────────────────────────────────────────

export type OnConfigChange = (newConfig: Config) => void;
const listeners: OnConfigChange[] = [];

export function onConfigChange(cb: OnConfigChange) {
  listeners.push(cb);
}

// ─── Directory helpers ─────────────────────────────────────────────────────────

function ensureConfigDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ─── Config Migration ─────────────────────────────────────────────────────────────

/**
 * Detects if a config object is in the old sectioned format.
 */
function isSectionedConfig(raw: Record<string, unknown>): boolean {
  return "general" in raw || "browser" in raw || "security" in raw || "performance" in raw;
}

/**
 * Migrates old sectioned config to new simplified flat format.
 */
function migrateToSimple(sectioned: any): Config {
  return {
    mode: sectioned.general?.mode || "session",
    session: sectioned.general?.session || "default",
    attachPort: sectioned.general?.attachPort || 0,
    agentId: sectioned.general?.agentId || crypto.randomUUID(),
    telemetry: sectioned.general?.telemetry || false,
    
    browserPath: sectioned.browser?.path || "auto",
    browserType: sectioned.browser?.type || "chromium",
    headless: sectioned.browser?.headless ?? false,
    visuals: sectioned.browser?.visuals ?? true,
    darkMode: sectioned.browser?.darkMode ?? true,
    disableExtensions: sectioned.browser?.disableExtensions || false,
    browserFlags: sectioned.browser?.flags || [],
    profileDir: sectioned.browser?.profileDir || "",
    cookies: sectioned.browser?.cookies || false,
    
    role: sectioned.security?.role || "admin",
    block: sectioned.security?.block || ["*.bank.*", "paypal.com"],
    allow: sectioned.security?.allow || [],
    policies: sectioned.security?.policies || [],
    
    sessionTimeout: sectioned.performance?.timeouts?.session || 3600,
    navigationTimeout: sectioned.performance?.timeouts?.navigation || 30000,
    idleTimeout: sectioned.performance?.timeouts?.idle || 60000,
    actionabilityTimeoutMs: sectioned.performance?.timeouts?.actionability || 500,
    maxTabs: sectioned.performance?.limits?.maxTabs || 10,
    maxActionsPerMinute: sectioned.performance?.limits?.maxActionsPerMinute || 60,
    githubCacheTtlMs: sectioned.performance?.cache?.githubTtlMs || 30 * 60 * 1000,
    refCacheTtlMs: sectioned.performance?.cache?.refCacheTtlMs || 30_000,
    
    downloadDir: sectioned.paths?.downloads || "",
    pdfDir: sectioned.paths?.pdfs || "",
    snapshotDir: sectioned.paths?.snapshots || "",
    recordingDir: sectioned.paths?.recordings || "",
    designDir: sectioned.paths?.designs || "",
    
    devMode: typeof sectioned.devMode === "boolean" ? sectioned.devMode : sectioned.devMode?.enabled || false,
    
    syncDataAcrossBrowsers: sectioned.general?.syncDataAcrossBrowsers || false,
    
    proxy: sectioned.network?.proxy,
  };
}

// ─── Per-field validation ──────────────────────────────────────────────────────

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

const isStr  = (v: unknown): v is string  => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isNum  = (v: unknown): v is number  => typeof v === "number" && isFinite(v);
const isArr  = (v: unknown): v is unknown[] => Array.isArray(v);

function validateConfig(raw: Record<string, unknown>): Config {
  // Detect old sectioned format and migrate to simplified format
  if (isSectionedConfig(raw)) {
    logDebug("[Weavetab Config] [INFO] Detected old sectioned config format, migrating to simplified structure...");
    const simple = migrateToSimple(raw);
    // Save migrated config
    try {
      fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(simple, null, 2));
      logDebug(`[Weavetab Config] [OK] Migrated config saved to ${GLOBAL_CONFIG_PATH}`);
    } catch (e) {
      logDebug("[Weavetab Config] [WARN] Failed to save migrated config:", e);
    }
    return simple;
  }

  // Validate simplified config
  return validateConfigInternal(raw);
}

function validateConfigInternal(raw: Record<string, unknown>): Config {
  const d = DEFAULT_CONFIG;
  const VALID_MODES    = ["session", "attach"] as const;
  const VALID_ENGINES  = ["chromium", "firefox", "webkit"] as const;
  const VALID_ROLES    = ["admin", "viewer", "automation", "system"] as const;
  const mode = validateField("mode", raw.mode, isStr, d.mode, v => (VALID_MODES as readonly string[]).includes(v)) as Config["mode"];

  // Path validation helpers
  function safePathField(field: string, value: unknown): string {
    if (!isStr(value) || !value.trim()) return "";
    const raw = value.trim();
    // Path traversal guard — check BEFORE resolving
    if (raw.includes("..") || raw.includes("~")) {
      logDebug(`[Weavetab Config] [WARN] Suspicious path in "${field}": "${raw}". Resetting to default.`);
      return "";
    }
    const resolved = path.resolve(raw);
    return resolved;
  }

  // Validate downloadDir — auto-create if missing
  const rawDownloadDir = safePathField("downloadDir", raw.downloadDir);
  let downloadDir = rawDownloadDir;
  if (downloadDir) {
    if (!fs.existsSync(downloadDir)) {
      try {
        fs.mkdirSync(downloadDir, { recursive: true });
        logDebug(`[Weavetab Config] [OK] Created custom download directory: ${downloadDir}`);
      } catch (e) {
        logDebug(`[Weavetab Config] [ERROR] Failed to create downloadDir "${downloadDir}". Resetting to default.`);
        downloadDir = "";
      }
    }
  }

  // Validate browser path — check file exists if not "auto"
  const rawBrowser = validateField("browserPath", raw.browserPath ?? "auto", isStr, d.browserPath);
  let browserPath = rawBrowser;
  if (browserPath && browserPath !== "auto") {
    // Only verify it exists if it looks like a path (contains slashes).
    // Otherwise it might be a browser name like "edge" or "brave".
    if ((browserPath.includes('/') || browserPath.includes('\\')) && !fs.existsSync(browserPath)) {
      logDebug(`[Weavetab Config] [WARN] browser path "${browserPath}" does not exist. Resetting to "auto".`);
      browserPath = "auto";
    }
  }

  // Validate profileDir — path safety only (real-browser guard is in profiles.ts)
  const profileDir = safePathField("profileDir", raw.profileDir);

  // Validate proxy — resolve env var and reject plaintext credentials
  let proxy = raw.proxy as string | undefined;
  if (proxy === "$WT_PROXY_URL") {
    proxy = process.env.WT_PROXY_URL;
  }
  if (proxy && /:\/\/[^:]+:[^@]+@/.test(proxy)) {
    logDebug(`[Weavetab Config] [WARN] Proxy contains literal credentials (://user:pass@). This is a security risk. Use an environment variable instead. Ignoring proxy.`);
    proxy = undefined;
  }

  return {
    mode,
    session:             validateField("session", raw.session, isStr, d.session),
    attachPort:          mode !== "attach" ? 0 : validateField("attachPort", raw.attachPort, isNum, d.attachPort, v => v >= 0 && v <= 65535),
    agentId:             isStr(raw.agentId) ? raw.agentId : d.agentId,
    telemetry:           validateField("telemetry", raw.telemetry, isBool, d.telemetry),
    
    browserPath,
    browserType:         validateField("browserType", raw.browserType, isStr, d.browserType, v => (VALID_ENGINES as readonly string[]).includes(v)) as BrowserEngine,
    headless:            validateField("headless", raw.headless, isBool, d.headless),
    visuals:             validateField("visuals", raw.visuals, isBool, d.visuals),
    darkMode:            validateField("darkMode", raw.darkMode, isBool, d.darkMode),
    disableExtensions:   validateField("disableExtensions", raw.disableExtensions, isBool, d.disableExtensions),
    browserFlags:        isArr(raw.browserFlags) ? (raw.browserFlags as unknown[]).filter(isStr) : d.browserFlags,
    profileDir,
    cookies:             validateField("cookies", raw.cookies, isBool, d.cookies),
    
    role:                validateField("role", raw.role, isStr, d.role, v => (VALID_ROLES as readonly string[]).includes(v)) as Role,
    block:               isArr(raw.block)  ? (raw.block  as unknown[]).filter(isStr) : d.block,
    allow:               isArr(raw.allow)  ? (raw.allow  as unknown[]).filter(isStr) : d.allow,
    policies:            isArr(raw.policies) ? raw.policies as PolicyEntry[] : d.policies,
    
    sessionTimeout:      validateField("sessionTimeout", raw.sessionTimeout, isNum, d.sessionTimeout, v => v >= 60 && v <= 86400),
    navigationTimeout:   validateField("navigationTimeout", raw.navigationTimeout, isNum, d.navigationTimeout, v => v >= 1000 && v <= 120000),
    idleTimeout:         validateField("idleTimeout", raw.idleTimeout, isNum, d.idleTimeout, v => v >= 5000),
    actionabilityTimeoutMs: validateField("actionabilityTimeoutMs", raw.actionabilityTimeoutMs, isNum, d.actionabilityTimeoutMs, v => v >= 50 && v <= 15000),
    maxTabs:             validateField("maxTabs", raw.maxTabs, isNum, d.maxTabs, v => v >= 1 && v <= 100),
    maxActionsPerMinute: validateField("maxActionsPerMinute", raw.maxActionsPerMinute, isNum, d.maxActionsPerMinute, v => v >= 1 && v <= 600),
    githubCacheTtlMs:    validateField("githubCacheTtlMs", raw.githubCacheTtlMs, isNum, d.githubCacheTtlMs, v => v >= 0),
    refCacheTtlMs:       validateField("refCacheTtlMs", raw.refCacheTtlMs, isNum, d.refCacheTtlMs, v => v >= 1000 && v <= 300_000),
    
    downloadDir,
    pdfDir:              safePathField("pdfDir", raw.pdfDir),
    snapshotDir:         safePathField("snapshotDir", raw.snapshotDir),
    recordingDir:        safePathField("recordingDir", raw.recordingDir),
    designDir:           safePathField("designDir", raw.designDir),
    
    devMode:             isBool(raw.devMode) ? raw.devMode : d.devMode,
    
    syncDataAcrossBrowsers: validateField("syncDataAcrossBrowsers", raw.syncDataAcrossBrowsers, isBool, d.syncDataAcrossBrowsers),
    
    proxy:               isStr(proxy) ? proxy : d.proxy,
  };
}

// ─── Safe JSON reader with broken-file recovery ────────────────────────────────

type ReadResult = 
  | { status: "ok";      data: Record<string, unknown>; file: string }
  | { status: "missing"; file: string }
  | { status: "broken";  file: string };

function safeReadJson(file: string): ReadResult {
  if (!fs.existsSync(file)) return { status: "missing", file };
  try {
    let raw = fs.readFileSync(file, "utf-8").trim();
    if (!raw) return { status: "missing", file }; // empty file = treat as missing (atomic write race)

    // Auto-fix unescaped Windows paths in JSON before parsing
    raw = raw.replace(/"([a-zA-Z]:\\[^"]*)"/g, (match, p1) => {
      const normalized = p1.replace(/\\\\/g, '\\').replace(/\\/g, '\\\\');
      return `"${normalized}"`;
    });

    const data = JSON.parse(raw);
    if (typeof data !== "object" || Array.isArray(data) || data === null) {
      return { status: "broken", file };
    }
    return { status: "ok", data: data as Record<string, unknown>, file };
  } catch {
    return { status: "broken", file };
  }
}

/** Renames a broken config file to config.broken.<timestamp>.json for forensics. */
const _lastQuarantine = new Map<string, number>();
const QUARANTINE_COOLDOWN_MS = 5_000; // min 5s between quarantines of same file

function quarantineBrokenConfig(file: string): void {
  const now = Date.now();
  const last = _lastQuarantine.get(file) || 0;
  if (now - last < QUARANTINE_COOLDOWN_MS) return; // too soon, skip
  _lastQuarantine.set(file, now);

  const dir  = path.dirname(file);
  const name = `config.broken.${Date.now()}.json`;
  const dest = path.join(dir, name);
  try {
    fs.renameSync(file, dest);
    logDebug(`[Weavetab Config] [WARN] Broken config quarantined → ${dest}`);

    // Limit quarantine folder size (keep last 5 broken files)
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

// ─── Multi-source merge pipeline ──────────────────────────────────────────────

/**
 * Priority: Global (user) → Built-in defaults
 * 
 * Each field is individually merged from global config.
 * If a config file is broken JSON it is quarantined and defaults are used.
 */
export function findProjectDir(startDir: string = process.cwd()): string | undefined {
  return undefined;
}

function resolveConfigMerge(): { config: Config; activeDir: string } {
  const globalDir  = GLOBAL_CONFIG_DIR;
  const globalFile = GLOBAL_CONFIG_PATH;

  // Ensure global dir always exists
  ensureConfigDir(globalDir);

  const globalResult = safeReadJson(globalFile);

  // Recover from broken files
  if (globalResult.status === "broken") {
    logDebug(`[Weavetab Config] [ERROR] Global config at "${globalFile}" is broken JSON!`);
    quarantineBrokenConfig(globalFile);
  }

  const hasGlobal = globalResult.status === "ok";

  // Check for project config
  const projectDir = findProjectDir();
  let projectFile: string | undefined;
  let projectResult: ReadResult | undefined;
  
  if (projectDir) {
    projectFile = path.join(projectDir, "config.json");
    if (fs.existsSync(projectFile)) {
      projectResult = safeReadJson(projectFile);
      if (projectResult.status === "broken") {
        logDebug(`[Weavetab Config] [ERROR] Project config at "${projectFile}" is broken JSON!`);
        quarantineBrokenConfig(projectFile);
      }
    }
  }

  const hasProject = projectResult && projectResult.status === "ok";
  const activeDir = projectDir && hasProject ? projectDir : globalDir;

  // Log the resolution decision
  if (hasProject) {
    logDebug(`[Weavetab Config] [OK] Loaded project config: ${projectFile} (overrides global)`);
    logDebug(`[Weavetab Config] [OK] Active directory: ${activeDir}`);
  } else if (hasGlobal) {
    logDebug(`[Weavetab Config] [OK] Using global config only: ${globalFile}`);
    logDebug(`[Weavetab Config] [OK] Active directory: ${activeDir}`);
  } else {
    logDebug(`[Weavetab Config] [WARN] No config found — using built-in defaults. Run: wt config`);
    logDebug(`[Weavetab Config] [OK] Active directory: ${activeDir}`);
    // Write a starter global config so user isn't surprised
    ensureConfigDir(globalDir);
    if (!fs.existsSync(globalFile)) {
      try {
        fs.writeFileSync(globalFile, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
        logDebug(`[Weavetab Config] [OK] Created starter config at: ${globalFile}`);
      } catch { /* non-fatal */ }
    }
  }

  // Field-by-field merge: project > global > default
  const globalData = hasGlobal ? (globalResult as { status: "ok"; data: Record<string, unknown>; file: string }).data : {};
  const projectData = hasProject ? (projectResult as { status: "ok"; data: Record<string, unknown>; file: string }).data : {};
  const merged: Record<string, unknown> = {
    ...DEFAULT_CONFIG as unknown as Record<string, unknown>,
    ...globalData,
    ...projectData,
  };

  const config = validateConfig(merged);
  
  // Fill in default paths for output directories when config has empty strings.
  // This ensures users see the actual paths (not "") when viewing their config.
  const dirDefaults: [keyof Config, string][] = [
    ["downloadDir", "downloads"],
    ["pdfDir", "pdfs"],
    ["snapshotDir", "snapshots"],
    ["recordingDir", "recordings"],
    ["designDir", "designs"],
  ];
  for (const [field, subdir] of dirDefaults) {
    if (!config[field]) {
      (config as any)[field] = path.join(activeDir, subdir);
    }
  }
  
  return { config, activeDir };
}

// ─── Backward-compat: legacy config migration ─────────────────────────────────

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

function migrateOldConfigIfNeeded(): void {
  if (fs.existsSync(GLOBAL_CONFIG_PATH)) return; // already done
  const hasSystem = fs.existsSync(OLD_SYSTEM_PATH);
  const hasUI     = fs.existsSync(OLD_UI_PATH);
  if (!hasSystem && !hasUI) return;

  let merged: Record<string, unknown> = { ...DEFAULT_CONFIG as unknown as Record<string, unknown> };
  if (hasSystem) {
    try { merged = { ...merged, ...JSON.parse(fs.readFileSync(OLD_SYSTEM_PATH, "utf-8")) }; }
    catch { logDebug("[Weavetab] Failed to parse old system.json"); }
  }
  if (hasUI) {
    try { merged = { ...merged, ...JSON.parse(fs.readFileSync(OLD_UI_PATH, "utf-8")) }; }
    catch { logDebug("[Weavetab] Failed to parse old ui_manifest.json"); }
  }
  merged.mode = "session";
  merged.attachPort = 0;

  ensureConfigDir(GLOBAL_CONFIG_DIR);
  fs.writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(merged, null, 2));
  logDebug("[Weavetab] Auto-migrated old config files to config.json.");
  try {
    if (hasSystem) fs.unlinkSync(OLD_SYSTEM_PATH);
    if (hasUI)     fs.unlinkSync(OLD_UI_PATH);
  } catch { /* ignore */ }
}

// ─── Active config path (for saveConfig + tools that need to know the dir) ────

/** 
 * Returns the "write target" directory for configs.
 * Priority: Project config if it exists, otherwise global.
 */
export function getActiveConfigPath(): { dir: string; file: string } {
  return { dir: GLOBAL_CONFIG_DIR, file: GLOBAL_CONFIG_PATH };
}

// ─── In-memory cache + live reload ────────────────────────────────────────────

let _cachedConfig: Config | null = null;
let _cachedActiveDir: string | null = null;

export function loadConfigSync(): Config {
  migrateOldConfigIfNeeded();
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

/** Zero disk I/O after first load. Refreshed by fs.watch. */
export function getCachedConfig(): Config {
  if (!_cachedConfig) _cachedConfig = loadConfigSync();
  return _cachedConfig;
}

/** Force re-read from disk on next getCachedConfig/loadConfig call. */
export function invalidateConfigCache(): void {
  _cachedConfig = null;
  _cachedActiveDir = null;
}

/** Returns the resolved active directory (global). */
export function getActiveDirCached(): string {
  if (!_cachedActiveDir) loadConfigSync();
  return _cachedActiveDir ?? GLOBAL_CONFIG_DIR;
}

// ─── Output directory resolution ──────────────────────────────────────────────
// Outputs use configurable paths from config, falling back to global Weavetab directory.

export function getOutputDir(subdir: "downloads" | "pdfs" | "snapshots" | "recordings" | "designs", config?: Config): string {
  if (!config) {
    // Fall back to default global directory
    const dir = path.join(GLOBAL_CONFIG_DIR, subdir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }
  
  // Map simplified config fields to subdirs
  const fieldMap: Record<string, string> = {
    downloads: "downloadDir",
    pdfs: "pdfDir",
    snapshots: "snapshotDir",
    recordings: "recordingDir",
    designs: "designDir"
  };
  
  const field = fieldMap[subdir];
  const customPath = (config as any)[field];
  
  if (customPath && customPath.trim()) {
    const resolved = customPath.trim();
    if (!fs.existsSync(resolved)) {
      try {
        fs.mkdirSync(resolved, { recursive: true });
      } catch { /* ignore */ }
    }
    return resolved;
  }
  
  // Fall back to default global directory
  const dir = path.join(GLOBAL_CONFIG_DIR, subdir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Helper to get download directory from config.
 */
export function getDownloadDir(config: Config): string {
  return config.downloadDir || "";
}

/**
 * Helper to get design output directory from config.
 */
export function getDesignDir(config: Config): string {
  return config.designDir || "";
}

// ─── Config Property Access Helpers ───────────────────────────────────────────────

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

export function getConfigVisuals(config: Config): boolean {
  return config.visuals;
}

export function getConfigDarkMode(config: Config): boolean {
  return config.darkMode;
}

export function getConfigDisableExtensions(config: Config): boolean {
  return config.disableExtensions;
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

export function getConfigGithubCacheTtl(config: Config): number {
  return config.githubCacheTtlMs;
}

export function getConfigRefCacheTtl(config: Config): number {
  return config.refCacheTtlMs;
}

export function getConfigDevMode(config: Config): boolean {
  return config.devMode;
}

// ─── Additional Helper Functions for Code Compatibility ─────────────────────────

export function getConfigNavigationTimeoutMs(config: Config): number {
  return config.navigationTimeout;
}


export function getConfigGithubCacheTtlMs(config: Config): number {
  return config.githubCacheTtlMs;
}

export function getConfigRefCacheTtlMs(config: Config): number {
  return config.refCacheTtlMs;
}

/**
 * Returns a directory inside the global Weavetab system folder.
 * User-facing outputs stay in `.weavetab/` — system internals go here.
 * Platform-specific locations for better organization.
 */
const GLOBAL_SYSTEM_DIR = path.join(HOME, ".weavetab-system");

export function getSystemDir(subdir: string): string {
  const dir = path.join(GLOBAL_SYSTEM_DIR, subdir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Returns a directory inside the global ~/.weavetab-system/ folder.
 * Alias for consistency — identical to getSystemDir.
 */
export function getGlobalSystemDir(subdir: string): string {
  const dir = path.join(GLOBAL_SYSTEM_DIR, subdir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}


export function saveConfig(config: Config): void {
  const { dir, file } = getActiveConfigPath();
  ensureConfigDir(dir);
  const mode = getConfigMode(config);
  if (mode !== "attach") {
    config.attachPort = 0;
  }
  // Atomic write: write to temp file then rename to prevent partial reads
  // from concurrent processes or crashes mid-write.
  const tmpFile = path.join(dir, `config.tmp.${process.pid}.json`);
  try {
    const content = JSON.stringify(config, null, 2);
    fs.writeFileSync(tmpFile, content, "utf-8");
    fs.renameSync(tmpFile, file);
  } catch (e) {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    throw e;
  }
  _cachedConfig = loadConfigSync();
  listeners.forEach(cb => cb(_cachedConfig!));
}

// ─── Live-reload watcher ───────────────────────────────────────────────────────

let watchTimeout: NodeJS.Timeout | null = null;

function startWatcher(dir: string) {
  try {
    if (!fs.existsSync(dir)) return;
    fs.watch(dir, (eventType, filename) => {
      if (filename === "config.json" && eventType === "change") {
        if (watchTimeout) clearTimeout(watchTimeout);
        watchTimeout = setTimeout(() => {
          try {
            _cachedConfig = loadConfigSync();
            listeners.forEach(cb => cb(_cachedConfig!));
          } catch (e) {
            logDebug("[Weavetab] Failed to reload config", e);
          }
        }, 150);
      }
    });
  } catch {
    // Ignore watch errors on some OS/network mounts
  }
}

// Watch global location so changes are picked up
startWatcher(GLOBAL_CONFIG_DIR);
