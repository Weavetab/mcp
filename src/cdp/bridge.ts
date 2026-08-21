import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — cdp/bridge.ts
 * Browser process launcher: sentinel lock, profile resolution, stderr port parsing.
 * V3 — includes 10s stderr timeout, stealth injection.
 * Weavetab by fy2ne
 */
import { spawn, exec, execSync, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, BrowserEngine } from "../config/loader.js";
import CDP from "chrome-remote-interface";
import { readLock, writeLock, clearLock, clearLockIfOwned, isLockValid, isLockPending } from "./lock.js";
import { getSessionProfile } from "./profiles.js";
import net from "node:net";
import { getOutputDir, getDownloadDir, getConfigHeadless, getConfigProxy, getConfigDisableExtensions, getConfigDevMode, getConfigBlock, getConfigAllow, getConfigBrowserType, getConfigBrowserPath, getConfigBrowserFlags, getConfigCookies, getConfigProfileDir, getSystemDir } from "../config/loader.js";
import { createBrowserFingerprint, safelyKillWeavetabProcesses } from "./security.js";

function withCDPTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}



const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Browser Auto-Detection ───────────────────────────────────────────────────

export interface BrowserInfo {
  name: string;
  path: string;
}

const BROWSER_PRIORITY = [
  "Google Chrome",
  "Brave",
  "Microsoft Edge",
  "Chromium"
];

// ─── Browser Path Validation ──────────────────────────────────────────────────────
// Validate that the browser path is a known safe browser executable
function isValidBrowserPath(browserPath: string): boolean {
  const platform = os.platform();
  const normalizedPath = browserPath.toLowerCase();

  // Known safe browser binary names
  const safeBinaries = [
    'chrome.exe', 'chrome', 'google chrome',
    'brave.exe', 'brave', 'brave browser',
    'msedge.exe', 'msedge', 'microsoft edge',
    'chromium.exe', 'chromium',
    'firefox.exe', 'firefox',
    'firefox.app', 'google chrome.app', 'brave browser.app', 'microsoft edge.app'
  ];

  // Check if the path contains a known browser binary name
  const hasSafeBinary = safeBinaries.some(binary =>
    normalizedPath.includes(binary) ||
    normalizedPath.endsWith(binary)
  );

  if (!hasSafeBinary) {
    logDebug(`[SECURITY] Browser path validation failed: unknown binary in path`);
    return false;
  }

  // Check for suspicious patterns that might indicate malicious paths
  const suspiciousPatterns = [
    '..', // path traversal
    '%', // URL encoding (suspicious in paths)
    'cmd.exe', 'powershell.exe', 'bash', 'sh', // shell executables
    'temp', 'tmp', // temporary directories
    'download', // downloads directory
  ];

  const hasSuspiciousPattern = suspiciousPatterns.some(pattern =>
    normalizedPath.includes(pattern)
  );

  if (hasSuspiciousPattern) {
    logDebug(`[SECURITY] Browser path validation failed: suspicious pattern in path`);
    return false;
  }

  // On Windows, check that the path is in a known safe location
  if (platform === 'win32') {
    const safeLocations = [
      'program files',
      'program files (x86)',
      'localappdata',
      'programdata',
      'c:\\users\\'
    ];

    const isInSafeLocation = safeLocations.some(location =>
      normalizedPath.includes(location) ||
      normalizedPath.startsWith('c:\\')
    );

    if (!isInSafeLocation) {
      logDebug(`[SECURITY] Browser path validation failed: not in safe location`);
      return false;
    }
  }

  // On macOS, check that the path is in /Applications
  if (platform === 'darwin') {
    if (!normalizedPath.startsWith('/applications/') && !normalizedPath.startsWith('/usr/local/bin/')) {
      logDebug(`[SECURITY] Browser path validation failed: not in safe location`);
      return false;
    }
  }

  // On Linux, check that the path is in a safe location
  if (platform === 'linux') {
    const safeLocations = ['/usr/bin/', '/usr/local/bin/', '/snap/bin/', '/opt/'];
    const isInSafeLocation = safeLocations.some(location => normalizedPath.startsWith(location));

    if (!isInSafeLocation) {
      logDebug(`[SECURITY] Browser path validation failed: not in safe location`);
      return false;
    }
  }

  return true;
}

function pathsForPlatform(browserName: string): string[] {
  const plat = os.platform();
  const winPaths: string[] = [];
  const macPaths: string[] = [];
  const linuxPaths: string[] = [];

  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.PROGRAMFILES || "";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "";

  if (browserName === "Google Chrome") {
    winPaths.push(
      `${programFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${programFilesX86}\\Google\\Chrome\\Application\\chrome.exe`,
      `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`
    );
    macPaths.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    linuxPaths.push("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/local/bin/google-chrome");
  } else if (browserName === "Brave") {
    winPaths.push(
      `${programFiles}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${programFilesX86}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      `${localAppData}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`
    );
    macPaths.push("/Applications/Brave Browser.app/Contents/MacOS/Brave Browser");
    linuxPaths.push("/usr/bin/brave-browser", "/usr/bin/brave");
  } else if (browserName === "Microsoft Edge") {
    winPaths.push(
      `${programFilesX86}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${programFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`
    );
    macPaths.push("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge");
    linuxPaths.push("/usr/bin/microsoft-edge", "/usr/bin/microsoft-edge-stable");
  } else if (browserName === "Chromium") {
    macPaths.push("/Applications/Chromium.app/Contents/MacOS/Chromium");
    linuxPaths.push("/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium");
  }

  if (plat === "win32") return winPaths.filter(Boolean);
  if (plat === "darwin") return macPaths;
  return linuxPaths;
}

export function findBrowser(preferred?: string): BrowserInfo | null {
  const platform = os.platform();

  if (preferred && (preferred.startsWith("/") || preferred.includes("/") || preferred.includes("\\"))) {
    const normalizedPath = platform === 'win32'
      ? preferred.replace(/\\/g, '\\')
      : preferred.replace(/\\\\/g, '/');

    if (fs.existsSync(normalizedPath)) {
      // Validate the configured browser path
      if (!isValidBrowserPath(normalizedPath)) {
        logDebug(`[SECURITY] Configured browser path failed validation: ${normalizedPath}`);
        return null;
      }

      const lowerPath = normalizedPath.toLowerCase();
      let browserName = "Custom";
      if (lowerPath.includes("edge") || lowerPath.includes("msedge")) browserName = "Microsoft Edge";
      else if (lowerPath.includes("chrome")) browserName = "Google Chrome";
      else if (lowerPath.includes("brave")) browserName = "Brave";
      else if (lowerPath.includes("chromium")) browserName = "Chromium";

      logDebug(`[Weavetab] Using configured browser path: ${browserName} at ${normalizedPath}`);
      return { name: browserName, path: normalizedPath };
    } else {
      logDebug(`[Weavetab] Configured browser path does not exist: ${normalizedPath}`);
    }
  }

  const list = preferred
    ? [
      ...BROWSER_PRIORITY.filter((name) => name.toLowerCase().includes(preferred.toLowerCase())),
      ...BROWSER_PRIORITY.filter((name) => !name.toLowerCase().includes(preferred.toLowerCase())),
    ]
    : BROWSER_PRIORITY;

  for (const name of list) {
    for (const p of pathsForPlatform(name)) {
      if (p && fs.existsSync(p)) {
        logDebug(`[Weavetab] Auto-detected browser: ${name} at ${p}`);
        return { name, path: p };
      }
    }
  }

  try {
    let cmd = "";
    if (platform === "win32") {
      cmd = "where chrome.exe brave.exe msedge.exe";
    } else if (platform === "darwin") {
      cmd = "which /Applications/Google\\\\ Chrome.app/Contents/MacOS/Google\\\\ Chrome /Applications/Brave\\\\ Browser.app/Contents/MacOS/Brave\\\\ Browser /Applications/Microsoft\\\\ Edge.app/Contents/MacOS/Microsoft\\\\ Edge";
    } else {
      cmd = "which google-chrome brave-browser microsoft-edge chromium";
    }

    const result = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n")[0];
    if (result && fs.existsSync(result)) {
      logDebug(`[Weavetab] Fallback browser found via system: ${result}`);
      return { name: "System Browser", path: result };
    }
  } catch { /* ignore */ }

  return null;
}

export function findFirefox(): BrowserInfo | null {
  const plat = os.platform();
  const paths: string[] = [];
  const programFiles = process.env.PROGRAMFILES || "";
  const programFilesX86 = process.env["PROGRAMFILES(X86)"] || "";
  const localAppData = process.env.LOCALAPPDATA || "";

  if (plat === "win32") {
    paths.push(
      `${programFiles}\\Mozilla Firefox\\firefox.exe`,
      `${programFilesX86}\\Mozilla Firefox\\firefox.exe`,
      `${localAppData}\\Mozilla Firefox\\firefox.exe`
    );
  } else if (plat === "darwin") {
    paths.push("/Applications/Firefox.app/Contents/MacOS/firefox");
  } else {
    paths.push("/usr/bin/firefox", "/usr/local/bin/firefox", "/snap/bin/firefox");
  }

  for (const p of paths) {
    if (p && fs.existsSync(p)) {
      return { name: "Firefox", path: p };
    }
  }
  try {
    const cmd = plat === "win32" ? "where firefox" : "which firefox";
    const result = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n")[0];
    if (result && fs.existsSync(result)) return { name: "Firefox", path: result };
  } catch { /* ignore */ }
  return null;
}

export function probeAllBrowsers(): BrowserInfo[] {
  const results: BrowserInfo[] = [];
  for (const name of BROWSER_PRIORITY) {
    for (const p of pathsForPlatform(name)) {
      if (p && fs.existsSync(p)) {
        results.push({ name, path: p });
        break;
      }
    }
  }
  return results;
}

// ─── Process killing helper (Cross-platform) ─────────────────────────────

function killProcess(pid: number): void {
  const platform = os.platform();
  try {
    if (platform === 'win32') {
      execFile('taskkill', ['/F', '/PID', String(pid)], () => { });
    } else {
      execFile('kill', ['-9', String(pid)], () => { });
    }
  } catch (e: any) {
    logDebug(`[Weavetab] Exception killing process ${pid}:`, e.message);
  }
}

// ─── Circuit breaker to prevent repeated failures ─────────────────────────────

const launchFailureCount = new Map<string, number>();
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 60_000; // 1 minute

function checkCircuitBreaker(profileDir: string): boolean {
  const now = Date.now();
  const failures = launchFailureCount.get(profileDir) || 0;

  // Reset if enough time has passed
  if (failures > 0 && now - (launchFailureCount.get(`${profileDir}_time`) || 0) > CIRCUIT_BREAKER_RESET_MS) {
    launchFailureCount.delete(profileDir);
    launchFailureCount.delete(`${profileDir}_time`);
    return false;
  }

  // Check if threshold exceeded
  if (failures >= CIRCUIT_BREAKER_THRESHOLD) {
    logDebug(`[Weavetab] [!] Circuit breaker triggered: Too many recent launch failures for profile. Waiting ${CIRCUIT_BREAKER_RESET_MS / 1000}s before retry.`);
    return true;
  }

  return false;
}

function recordLaunchFailure(profileDir: string): void {
  const failures = (launchFailureCount.get(profileDir) || 0) + 1;
  launchFailureCount.set(profileDir, failures);
  launchFailureCount.set(`${profileDir}_time`, Date.now());
  logDebug(`[Weavetab] [!] Launch failure recorded (${failures}/${CIRCUIT_BREAKER_THRESHOLD}). Circuit breaker will trigger at ${CIRCUIT_BREAKER_THRESHOLD}.`);
}

function recordLaunchSuccess(profileDir: string): void {
  launchFailureCount.delete(profileDir);
  launchFailureCount.delete(`${profileDir}_time`);
}

// ─── Stealth script: injected before any page JS runs ─────────────────────────

const STEALTH_SCRIPT = `
(function() {
  'use strict';

  // 1. Spoof navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  // 2. Remove chrome automation props
  if (window.navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
      configurable: true,
    });
  }

  // 3. Spoof navigator.languages (defaults to en-US if unset)
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true,
    });
  }

  // 4. Spoof Chrome runtime
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};

  // 5. Randomize hardwareConcurrency (4–8 cores)
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => 4 + Math.floor(Math.random() * 4),
    configurable: true,
  });

  // 6. Randomize deviceMemory (4, 8, or 12 GB, weighted toward 8)
  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => [4, 8, 8, 8, 12][Math.floor(Math.random() * 5)],
    configurable: true,
  });

  // 7. WebGL vendor/renderer spoofing — only spoof the two info params,
  //    pass everything else through untouched. Wrapped in try/catch so a
  //    missing WebGL context never breaks the page.
  try {
    var _origGetParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return 'Google Inc. (Intel)';
      if (p === 37446) {
        return navigator.platform.indexOf('Mac') === 0
          ? 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)'
          : 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      }
      return _origGetParam.apply(this, arguments);
    };
    if (typeof WebGL2RenderingContext !== 'undefined') {
      var _origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function(p) {
        if (p === 37445) return 'Google Inc. (Intel)';
        if (p === 37446) {
          return navigator.platform.indexOf('Mac') === 0
            ? 'ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)'
            : 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
        }
        return _origGetParam2.apply(this, arguments);
      };
    }
  } catch(e) {}

  // NOTE: Function.prototype.toString proxy removed — it was wrapping
  // every toString call globally and could break page rendering.
})();
`;

// ─── Mandatory security flags (always applied, never overridable) ──────────────

const MANDATORY_FLAGS: ReadonlyArray<string> = Object.freeze([
  "--disable-sync",
]);

/**
 * Returns the "key" part of a Chrome flag (everything before the first =).
 * Example: "--disable-sync=foo" → "--disable-sync"
 */
function getFlagKey(flag: string): string {
  return flag.split("=")[0];
}

/**
 * Filters custom browser flags, dropping any that conflict with mandatory
 * security flags. Handles the --enable-foo / --disable-foo symmetry.
 */
function filterBrowserFlags(customFlags: string[]): string[] {
  const mandatoryKeys = new Set(MANDATORY_FLAGS.map(getFlagKey));
  // Add derived conflicting keys (--enable-* for a --disable-* mandatory flag and vice versa)
  for (const key of mandatoryKeys) {
    if (key.startsWith("--disable-")) {
      mandatoryKeys.add("--enable-" + key.slice("--disable-".length));
    }
    if (key.startsWith("--enable-")) {
      mandatoryKeys.add("--disable-" + key.slice("--enable-".length));
    }
  }
  return customFlags.filter(flag => {
    const key = getFlagKey(flag);
    if (mandatoryKeys.has(key)) {
      logDebug(`[Weavetab] ⚠ Custom browser flag "${flag}" conflicts with a mandatory security flag. Dropping it.`);
      return false;
    }
    return true;
  });
}

// ─── Launch flags ─────────────────────────────────────────────────────────────

function getLaunchFlags(config: Config, extPath: string): string[] {
  const plat = os.platform();
  const flags: string[] = [
    "--disable-blink-features=AutomationControlled",
    "--test-type",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-default-apps",
    "--no-service-autorun",
    "--disable-background-mode",
    "--disable-backgrounding-occluded-windows",
    "--start-maximized",
    "--disable-infobars",
  ];

  // Platform-specific flags
  if (plat === "win32") {
    // Windows: prevent browser from becoming default
    flags.push("--disable-features=TranslateUI");
    flags.push("--disable-features=DefaultBrowserGuidance");
  } else if (plat === "darwin") {
    // macOS: use mock keychain to prevent password prompts
    flags.push("--use-mock-keychain");
    // Prevent macOS from showing permission prompts
    flags.push("--disable-mac-overlays");
  } else if (plat === "linux") {
    // Linux: use basic password store to prevent keyring issues
    flags.push("--password-store=basic");
  }

  if (getConfigHeadless(config)) flags.push("--headless=new");
  if (getConfigProxy(config)) flags.push(`--proxy-server=${getConfigProxy(config)}`);

  // disableExtensions: NOTE — --disable-extensions kills ALL extensions including ours.
  // --load-extension does NOT reliably override --disable-extensions on Edge.
  // Since we can't disable other extensions while keeping ours (unpacked extensions
  // have unpredictable IDs), we skip the flag entirely and let other extensions coexist.
  // The user can manually disable extensions in their browser profile if needed.
  if (getConfigDisableExtensions(config)) {
    logDebug("[Weavetab] [SAFETY] disableExtensions=true — cannot safely disable other extensions while keeping Weavetab extension. Loading extension alongside any existing ones.");
  }

  // devMode: enable verbose remote debugging
  if (getConfigDevMode(config)) {
    flags.push("--enable-logging", "--v=1");
  }

  // Block list → Chrome --host-rules (blocks at DNS level)
  const blockRules: string[] = [];
  const blockList = getConfigBlock(config);
  if (blockList && blockList.length > 0) {
    for (const domain of blockList) {
      // Strip wildcards for host-rules format
      const cleaned = domain.replace(/^\*\./, "");
      blockRules.push(`MAP ${cleaned} 0.0.0.0`, `MAP *.${cleaned} 0.0.0.0`);
    }
  }
  // Allow list overrides block list
  const allowList = getConfigAllow(config);
  if (allowList && allowList.length > 0) {
    for (const domain of allowList) {
      blockRules.push(`EXCLUDE ${domain}`, `EXCLUDE *.${domain}`);
    }
  }
  if (blockRules.length > 0) {
    flags.push(`--host-resolver-rules=${blockRules.join(", ")}`);
  }

  // Mandatory security flags applied AFTER all configurable flags
  // These cannot be overridden by any config setting
  flags.push(...MANDATORY_FLAGS);

  return flags;
}

// ─── Main launcher ────────────────────────────────────────────────────────────

export async function launchWithBridge(
  config: Config
): Promise<{ path: string; name: string; port: number; engine?: BrowserEngine }> {
  const engine: BrowserEngine = getConfigBrowserType(config) || "chromium";

  if (engine !== "chromium") {
    return launchNonChromium(config, engine);
  }

  const browserPath = getConfigBrowserPath(config);
  const browser = browserPath && browserPath !== "auto"
    ? findBrowser(browserPath)
    : findBrowser();

  if (!browser) {
    throw new Error(
      "[Weavetab] ✗ No Chromium browser found on this system.\n" +
      "  Please install one of the following supported browsers:\n" +
      "  - Google Chrome (https://www.google.com/chrome/)\n" +
      "  - Brave (https://brave.com/)\n" +
      "  - Microsoft Edge (https://www.microsoft.com/edge)\n" +
      "  If you have a browser installed in a custom location, set it via: wt config browserPath \"/path/to/browser\""
    );
  }

  const debugPort = 0;

  const lock = readLock();
  if (lock && lock.mode === "session") {
    if (isLockPending(lock)) {
      logDebug(`[Weavetab] Launch already in progress (PID: ${lock.pid}). Waiting...`);
      throw new Error("Launch already in progress. Wait for it to complete.");
    }
    const valid = await isLockValid(lock);
    if (valid) {
      logDebug(`[Weavetab] [OK] Reusing valid lock (PID: ${lock.pid}, Port: ${lock.port})`);
      return { path: browser.path, name: browser.name, port: lock.port, engine: "chromium" };
    }
    logDebug(`[Weavetab] [!] Stale lock detected. Clearing.`);
    clearLock();
  } else if (lock) {
    clearLock();
  }

  const MAX_ATTEMPTS = 3;
  let lastError: Error | null = null;
  const profileDir = getSessionProfile(getConfigCookies(config), getConfigProfileDir(config), config.syncDataAcrossBrowsers, browser.path);

  // Circuit breaker check before attempting launch
  if (checkCircuitBreaker(profileDir)) {
    throw new Error(`[Weavetab] Circuit breaker triggered: Too many recent launch failures. Please wait ${CIRCUIT_BREAKER_RESET_MS / 1000}s before retrying.`);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      logDebug(`[Weavetab] [!] Retrying browser launch (attempt ${attempt}/${MAX_ATTEMPTS}) after 1.5s...`);
      
      // Auto-recovery for corrupted profiles (e.g., FrameWidgetHost mojo crashes after hard kill).
      // If we reach the final attempt, nuke the isolated session profile as a last resort to recover.
      if (attempt === MAX_ATTEMPTS && profileDir.includes(".weavetab-system") && profileDir.includes("session-profile")) {
        logDebug(`[Weavetab] [!] Wiping potentially corrupted session profile as last resort: ${profileDir}`);
        try {
          fs.rmSync(profileDir, { recursive: true, force: true });
        } catch { /* ignore */ }
      }

      // Do NOT clear the lock between retries — that creates a ~1500ms window where
      // another concurrent getOrConnect() sees no lock and races to start a second browser.
      // Instead, keep the pending lock alive (or write a fresh one) so concurrent calls
      // wait on it rather than spawning their own instance.
      await writeLock({ pid: process.pid, port: 0, profileDir, browserPath: browser.path, mode: "session", pending: true, timestamp: Date.now() });
      await new Promise(r => setTimeout(r, 1500));
    }

    try {
      let extPath = path.resolve(__dirname, "../../ext-dist");
      const systemExtPath = getSystemDir("extension");

      if (fs.existsSync(extPath)) {
        try {
          fs.cpSync(extPath, systemExtPath, { recursive: true, force: true });
        } catch (e) {
          logDebug(`[Weavetab] Failed to sync extension to system directory: ${e}`);
        }
      } else {
        if (fs.existsSync(systemExtPath)) {
          logDebug(`[Weavetab] Local extension missing. Falling back to system extension directory.`);
          extPath = systemExtPath;
        } else {
          throw new Error(`[Weavetab] Extension directory does not exist: ${extPath}. Build the extension first.`);
        }
      }

      const manifestPath = path.join(extPath, "manifest.json");
      const contentPath = path.join(extPath, "content.js");
      const backgroundPath = path.join(extPath, "background.js");

      if (!fs.existsSync(manifestPath)) {
        throw new Error(`[Weavetab] Extension manifest missing: ${manifestPath}`);
      }
      if (!fs.existsSync(contentPath)) {
        throw new Error(`[Weavetab] Extension content script missing: ${contentPath}`);
      }
      if (!fs.existsSync(backgroundPath)) {
        throw new Error(`[Weavetab] Extension background script missing: ${backgroundPath}`);
      }

      const resolvedDownloadDir = getDownloadDir(config) && getDownloadDir(config).trim()
        ? getDownloadDir(config).trim()
        : getOutputDir("downloads", config);

      // Normalize paths for cross-platform compatibility
      const platform = os.platform();
      const normalizedExtPath = platform === 'win32'
        ? extPath.replace(/\//g, '\\')
        : extPath;
      const normalizedProfileDir = platform === 'win32'
        ? profileDir.replace(/\//g, '\\')
        : profileDir;
      const normalizedDownloadDir = platform === 'win32'
        ? resolvedDownloadDir.replace(/\//g, '\\')
        : resolvedDownloadDir;

      // Clean up stale Chrome SingletonLock from previous session.
      // On Windows, Browser.close() sometimes doesn't fully release the lock
      // before Node.js spawns a new Chrome, causing it to start without extensions.
      const singletonLock = path.join(profileDir, "SingletonLock");
      const singletonCookie = path.join(profileDir, "SingletonCookie");
      try { if (fs.existsSync(singletonLock)) fs.unlinkSync(singletonLock); } catch { /* non-fatal */ }
      try { if (fs.existsSync(singletonCookie)) fs.unlinkSync(singletonCookie); } catch { /* non-fatal */ }

      // Wipe the MV3 service worker cache before every launch so Chrome always
      // executes the latest background.js from disk rather than a stale cached
      // script stored in the profile. Without this, edits to ext-dist/background.js
      // have no effect until Chrome manually reloads the extension — the SW cache
      // (Default/Service Worker/ScriptCache + Default/Service Worker/Database) is
      // keyed by URL hash and persists across sessions in the user-data-dir.
      // This ensures any future background.js change takes effect immediately
      // on all existing profiles without manual cache clearing.
      try {
        const swBase = path.join(profileDir, "Default", "Service Worker");
        const swScriptCache = path.join(swBase, "ScriptCache");
        const swDatabase = path.join(swBase, "Database");
        if (fs.existsSync(swScriptCache)) {
          fs.rmSync(swScriptCache, { recursive: true, force: true });
          logDebug("[Weavetab] Wiped SW ScriptCache to force background.js reload.");
        }
        if (fs.existsSync(swDatabase)) {
          fs.rmSync(swDatabase, { recursive: true, force: true });
          logDebug("[Weavetab] Wiped SW Database to force background.js reload.");
        }
      } catch (swErr) {
        logDebug(`[Weavetab] SW cache wipe failed (non-fatal): ${swErr}`);
      }

      const args = [
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${normalizedProfileDir}`,
        `--default-download-dir=${normalizedDownloadDir}`,
        ...getLaunchFlags(config, extPath),
        ...filterBrowserFlags(getConfigBrowserFlags(config) || []),
        `--load-extension=${normalizedExtPath}`,
        // NOTE: --disable-extensions-except was removed. It was killing any
        // extensions the user manually loaded into the Weavetab profile.
        // --load-extension alone is sufficient to auto-load the Weavetab extension.
        "about:blank",
      ];

      let pid: number | undefined;

      // Cross-platform spawn options
      const spawnOptions: any = {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      };

      // On macOS, sometimes we need to set the shell to true for .app paths
      if (platform === 'darwin' && browser.path.includes('.app')) {
        spawnOptions.shell = true;
      }

      // Validate browser path before spawning
      if (!isValidBrowserPath(browser.path)) {
        throw new Error(`Security violation: Invalid browser path: ${browser.path}`);
      }

      const proc = spawn(browser.path, args, spawnOptions);
      proc.unref();
      pid = proc.pid;
      logDebug(`[Weavetab] Launching ${browser.name} (PID: ${pid}, port: auto, attempt: ${attempt}).`);

      let actualPort: number;
      try {
        actualPort = await resolvePortFromStderr(proc, pid, engine);
      } catch (portErr) {
        // Kill process just in case it's still alive
        try { if (pid) killProcess(pid); } catch { /* ignore */ }
        clearLock();
        lastError = portErr instanceof Error ? portErr : new Error(String(portErr));
        logDebug(`[Weavetab] [!] Attempt ${attempt} failed to resolve port: ${lastError.message}`);
        continue;
      }

      // Create a browser fingerprint for process identity verification
      const fingerprint = createBrowserFingerprint(pid || 0, actualPort, profileDir, browser.path);
      await writeLock({
        pid,
        port: actualPort,
        profileDir,
        browserPath: browser.path,
        mode: "session",
        pending: true,
        timestamp: Date.now(),
        fingerprint: {
          launchTimestamp: fingerprint.launchTimestamp,
        }
      });

      const probePort = actualPort;
      let confirmed = false;
      for (let i = 0; i < 20; i++) {
        try {
          await withCDPTimeout(CDP.List({ host: "127.0.0.1", port: probePort }), 2000, "CDP.List");
          confirmed = true;
          break;
        } catch {
          await new Promise(r => setTimeout(r, 800));
        }
      }

      if (!confirmed) {
        logDebug(`[Weavetab] [!] Browser not confirmed after 16s on attempt ${attempt}.`);
        // Still proceed — browser may be loading slowly
      } else {
        logDebug(`[Weavetab] [OK] ${browser.name} ready on :${actualPort} (attempt ${attempt})`);

        // Verify extension loaded by checking for extension pages.
        // MV3 service workers can take 1-3s to initialize after Chrome starts,
        // so we wait briefly before querying targets.
        try {
          await new Promise(r => setTimeout(r, 1500));
          const testSession = await withCDPTimeout(CDP({ host: "127.0.0.1", port: actualPort }), 4000, "CDP connect");
          const { targetInfos } = await withCDPTimeout(testSession.Target.getTargets(), 4000, "getTargets");
          const extensionTargets = targetInfos.filter(t => t.type === "service_worker" || (t.type === "page" && t.url.startsWith("chrome-extension://")));
          await testSession.close();

          if (extensionTargets.length > 0) {
            logDebug(`[Weavetab] [OK] Extension loaded - found ${extensionTargets.length} extension target(s)`);
          } else {
            logDebug(`[Weavetab] [!] Extension may not have loaded - no extension targets found. Check chrome://extensions in the browser.`);
          }
        } catch (extCheckErr) {
          logDebug(`[Weavetab] [!] Could not verify extension load: ${extCheckErr}`);
        }
      }

      await writeLock({ pid, port: actualPort, profileDir, browserPath: browser.path, mode: "session", pending: false });
      recordLaunchSuccess(profileDir);
      return { ...browser, port: actualPort, engine: "chromium" };

    } catch (err) {
      clearLock();
      recordLaunchFailure(profileDir);
      lastError = err instanceof Error ? err : new Error(String(err));
      logDebug(`[Weavetab] [!] Launch attempt ${attempt} failed: ${lastError.message}`);
    }
  }

  throw new Error(`[Weavetab] Browser failed to launch after ${MAX_ATTEMPTS} attempts. Last error: ${lastError?.message ?? "unknown"}`);
}


async function launchNonChromium(config: Config, engine: BrowserEngine): Promise<{ path: string; name: string; port: number; engine: BrowserEngine }> {
  let browser: { path: string; name: string } | null = null;

  if (engine === "firefox") {
    browser = findFirefox();
  } else if (engine === "webkit") {
    // Safari Technology Preview — experimental
    const safariPaths = os.platform() === "darwin"
      ? ["/Applications/Safari Technology Preview.app/Contents/MacOS/safaridriver"]
      : [];
    for (const p of safariPaths) {
      if (fs.existsSync(p)) { browser = { name: "Safari TP", path: p }; break; }
    }
  }

  if (!browser) {
    throw new Error(
      `[Weavetab] No ${engine} browser found.\n` +
      `  Install ${engine === "firefox" ? "Firefox" : "Safari Technology Preview"} and try again.`
    );
  }

  const debugPort = 0;
  const profileDir = getSessionProfile(getConfigCookies(config), getConfigProfileDir(config));

  const args: string[] = [];
  if (engine === "firefox") {
    args.push(
      `--remote-debugging-port=${debugPort}`,
      `--profile`, profileDir,
      "--new-tab", "about:blank",
    );
  } else {
    // WebKit: Safari Technology Preview
    args.push(
      `--remote-debugging-port=${debugPort}`,
    );
  }

  const proc = spawn(browser.path, args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  proc.unref();
  const pid = proc.pid;
  logDebug(`[Weavetab] Launching ${browser.name} (${engine}, PID: ${pid}, port: auto).`);

  const actualPort = await resolvePortFromStderr(proc, pid, engine);

  for (let i = 0; i < 15; i++) {
    try {
      await withCDPTimeout(CDP.List({ host: "127.0.0.1", port: actualPort }), 2000, "CDP.List nonChromium");
      logDebug(`[Weavetab] [OK] ${browser.name} ready on :${actualPort}`);
      return { path: browser.path, name: browser.name, port: actualPort, engine };
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  logDebug(`[Weavetab] [!] ${browser.name} not confirmed after 15s — proceeding with port ${actualPort}.`);
  return { path: browser.path, name: browser.name, port: actualPort, engine };
}

// ─── Stealth injection helper ─────────────────────────────────────────────────

export async function injectStealthScript(session: CDP.Client): Promise<void> {
  try {
    await session.Page.addScriptToEvaluateOnNewDocument({ source: STEALTH_SCRIPT });
    await session.Runtime.evaluate({ expression: STEALTH_SCRIPT }).catch(() => { });
  } catch { /* ignore */ }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resolvePortFromStderr(
  proc: ReturnType<typeof spawn>,
  pid: number | undefined,
  _engine?: BrowserEngine
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let resolved = false;
    const TIMEOUT_MS = 10_000;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { proc.stderr?.destroy(); } catch { /* ignore */ }
        logDebug(`[Weavetab] [!] Browser did not emit DevTools port within 10s. Killing PID ${pid}.`);
        try { if (pid) killProcess(pid); } catch { /* ignore */ }
        clearLock();
        reject(new Error("[Weavetab] Browser launch timed out — no DevTools port emitted on stderr."));
      }
    }, TIMEOUT_MS);

    let stderrData = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrData += chunk.toString();

      // Check for extension loading errors
      if (stderrData.toLowerCase().includes("extension") &&
        (stderrData.toLowerCase().includes("error") ||
          stderrData.toLowerCase().includes("failed") ||
          stderrData.toLowerCase().includes("could not load"))) {
        logDebug(`[Weavetab] [!] Extension loading error detected in stderr: ${stderrData.slice(-500)}`);
      }

      const match = stderrData.match(/DevTools listening on ws:\/\/[\d.]+:(\d+)/);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        try { proc.stderr?.destroy(); } catch { /* ignore */ }
        const port = parseInt(match[1]!, 10);
        logDebug(`[Weavetab] [OK] Resolved dynamic port: ${port}`);
        resolve(port);
      }
    });

    proc.on("exit", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        try { proc.stderr?.destroy(); } catch { /* ignore */ }
        clearLock();
        reject(new Error(`[Weavetab] Browser process exited (code ${code}) before emitting DevTools port.`));
      }
    });
  });
}
