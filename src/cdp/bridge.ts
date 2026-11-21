import { logDebug } from "../audit/logger.js";
import { spawn, execSync, execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, BrowserEngine } from "../config/loader.js";
import CDP from "chrome-remote-interface";
import { readLock, writeLock, clearLock, isLockValid, isLockPending } from "./lock.js";
import { getSessionProfile, getElectronProfile } from "./profiles.js";
import { isValidElectronExecutablePath, resolveElectronExecutablePath } from "../desktop/discovery.js";
import net from "node:net";
import { getOutputDir, getDownloadDir, getConfigHeadless, getConfigProxy, getConfigDevMode, getConfigBlock, getConfigAllow, getConfigBrowserType, getConfigBrowserPath, getConfigBrowserFlags, getConfigCookies, getConfigProfileDir, getSystemDir, getElectronAppConfig, getConfigExtension } from "../config/loader.js";
import { createBrowserFingerprint } from "./security.js";

function withCDPTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer!));
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const SAFE_BROWSER_BINARIES = new Set([
  "chrome.exe", "chrome", "google chrome",
  "brave.exe", "brave", "brave browser", "brave-browser",
  "msedge.exe", "msedge", "microsoft edge", "microsoft-edge", "microsoft-edge-stable",
  "chromium.exe", "chromium", "chromium-browser",
  "google-chrome", "google-chrome-stable",
  "firefox.exe", "firefox"
]);

const BLOCKED_SCRIPT_EXTS = new Set([".bat", ".cmd", ".ps1", ".vbs", ".sh", ".js", ".wsf"]);
const BLOCKED_SHELL_NAMES = new Set([
  "sh", "bash", "zsh", "dash", "fish",
  "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe",
  "wscript", "wscript.exe", "cscript", "cscript.exe"
]);

export function isValidBrowserPath(browserPath: string): boolean {
  if (!browserPath || typeof browserPath !== "string") return false;
  const trimmed = browserPath.trim();
  const normalizedPath = trimmed.toLowerCase();

  const forbiddenChars = ["%", ";", "|", "&", "`", "$", "\n", "\r", "\0"];
  if (forbiddenChars.some((ch) => normalizedPath.includes(ch))) {
    logDebug(`[SECURITY] Browser path validation failed: forbidden char in path`);
    return false;
  }

  const rawSegments = trimmed.split(/[\\/]+/);
  if (rawSegments.includes("..")) {
    logDebug(`[SECURITY] Browser path validation failed: traversal segment in path`);
    return false;
  }

  const resolved = path.resolve(trimmed);
  const resolvedLower = resolved.toLowerCase();
  const baseName = path.basename(resolvedLower);
  const ext = path.extname(baseName);

  if (BLOCKED_SCRIPT_EXTS.has(ext) || BLOCKED_SHELL_NAMES.has(baseName)) {
    logDebug(`[SECURITY] Browser path validation failed: blocked script/shell binary`);
    return false;
  }

  if (!SAFE_BROWSER_BINARIES.has(baseName)) {
    logDebug(`[SECURITY] Browser path validation failed: unknown binary ${baseName}`);
    return false;
  }

  const platform = os.platform();
  if (platform === "win32") {
    if (!/^[a-z]:\\/.test(resolvedLower)) {
      logDebug(`[SECURITY] Browser path validation failed: expected absolute Windows path`);
      return false;
    }
  } else if (platform === "darwin") {
    if (!resolvedLower.startsWith("/applications/") && !resolvedLower.startsWith("/usr/local/bin/") && !resolvedLower.startsWith("/opt/")) {
      logDebug(`[SECURITY] Browser path validation failed: not in safe location`);
      return false;
    }
  } else if (platform === "linux") {
    const safeLocations = ["/usr/bin/", "/usr/local/bin/", "/snap/bin/", "/opt/", "/home/", "/usr/share/"];
    if (!safeLocations.some(location => resolvedLower.startsWith(location))) {
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
    if (!isValidBrowserPath(preferred)) {
      logDebug(`[SECURITY] Configured browser path failed validation: ${preferred}`);
      return null;
    }
    const normalizedPath = path.resolve(preferred.trim());

    if (fs.existsSync(normalizedPath)) {
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

  const prefKey = preferred?.toLowerCase() === "msedge" ? "edge" : preferred?.toLowerCase();
  const list = prefKey
    ? [
      ...BROWSER_PRIORITY.filter((name) => name.toLowerCase().includes(prefKey)),
      ...BROWSER_PRIORITY.filter((name) => !name.toLowerCase().includes(prefKey)),
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
      cmd = "which /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome /Applications/Brave\\ Browser.app/Contents/MacOS/Brave\\ Browser /Applications/Microsoft\\ Edge.app/Contents/MacOS/Microsoft\\ Edge";
    } else {
      cmd = "which google-chrome brave-browser microsoft-edge chromium";
    }

    const foundLine = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split(/\r?\n/)[0]
      ?.trim();
    if (foundLine && fs.existsSync(foundLine)) {
      logDebug(`[Weavetab] Fallback browser found via system: ${foundLine}`);
      return { name: "System Browser", path: foundLine };
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
    const foundLine = execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split(/\r?\n/)[0]
      ?.trim();
    if (foundLine && fs.existsSync(foundLine)) return { name: "Firefox", path: foundLine };
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

function killProcess(pid: number, tree = false): void {
  const platform = os.platform();
  try {
    if (platform === "win32") {
      const args = tree ? ["/T", "/F", "/PID", String(pid)] : ["/F", "/PID", String(pid)];
      execFile("taskkill", args, () => {});
    } else {
      execFile("kill", ["-9", String(pid)], () => {});
    }
  } catch (e: any) {
    logDebug(`[Weavetab] Exception killing process ${pid}:`, e.message);
  }
}

const launchFailureCount = new Map<string, number>();
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_RESET_MS = 60_000;

function checkCircuitBreaker(profileDir: string): boolean {
  const now = Date.now();
  const failures = launchFailureCount.get(profileDir) || 0;

  if (failures > 0 && now - (launchFailureCount.get(`${profileDir}_time`) || 0) > CIRCUIT_BREAKER_RESET_MS) {
    launchFailureCount.delete(profileDir);
    launchFailureCount.delete(`${profileDir}_time`);
    return false;
  }

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

const STEALTH_SCRIPT = `
(function() {
  'use strict';

  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  if (window.navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
      configurable: true,
    });
  }

  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
      configurable: true,
    });
  }

  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {};

  Object.defineProperty(navigator, 'hardwareConcurrency', {
    get: () => 4 + Math.floor(Math.random() * 4),
    configurable: true,
  });

  Object.defineProperty(navigator, 'deviceMemory', {
    get: () => [4, 8, 8, 8, 12][Math.floor(Math.random() * 5)],
    configurable: true,
  });

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
})();
`;

const MANDATORY_FLAGS: ReadonlyArray<string> = Object.freeze([
  "--disable-sync",
]);

const FORBIDDEN_USER_FLAG_KEYS = new Set([
  "--user-data-dir",
  "--remote-debugging-port",
  "--remote-debugging-address",
  "--remote-allow-origins",
  "--disable-web-security",
]);

function getFlagKey(flag: string): string {
  return flag.trim().split("=")[0]!.toLowerCase();
}

export function filterBrowserFlags(customFlags: string[]): string[] {
  const mandatoryKeys = new Set(MANDATORY_FLAGS.map(getFlagKey));
  for (const key of Array.from(mandatoryKeys)) {
    if (key.startsWith("--disable-")) {
      mandatoryKeys.add("--enable-" + key.slice("--disable-".length));
    }
    if (key.startsWith("--enable-")) {
      mandatoryKeys.add("--disable-" + key.slice("--enable-".length));
    }
  }
  for (const fk of FORBIDDEN_USER_FLAG_KEYS) {
    mandatoryKeys.add(fk);
  }

  const out: string[] = [];
  for (let i = 0; i < customFlags.length; i++) {
    const flag = customFlags[i];
    if (!flag || typeof flag !== "string") continue;
    const key = getFlagKey(flag);
    if (mandatoryKeys.has(key)) {
      logDebug(`[Weavetab] ⚠ Custom browser flag "${flag}" conflicts with a mandatory security flag. Dropping it.`);
      if (!flag.includes("=") && FORBIDDEN_USER_FLAG_KEYS.has(key) && i + 1 < customFlags.length && !customFlags[i + 1]?.startsWith("-")) {
        i++;
      }
      continue;
    }
    out.push(flag);
  }
  return out;
}

function getLaunchFlags(config: Config, _extPath: string): string[] {
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

  if (plat === "win32") {
    flags.push("--disable-features=TranslateUI,DefaultBrowserGuidance");
  } else if (plat === "darwin") {
    flags.push("--use-mock-keychain");
    flags.push("--disable-mac-overlays");
  } else if (plat === "linux") {
    flags.push("--password-store=basic");
  }

  if (getConfigHeadless(config)) flags.push("--headless=new");
  if (getConfigProxy(config)) flags.push(`--proxy-server=${getConfigProxy(config)}`);

  if (getConfigDevMode(config)) {
    flags.push("--enable-logging", "--v=1");
  }

  const hostRules: string[] = [];
  const allowList = getConfigAllow(config);
  if (allowList && allowList.length > 0) {
    for (const domain of allowList) {
      const cleaned = domain.replace(/^\*\./, "");
      hostRules.push(`EXCLUDE ${cleaned}`, `EXCLUDE *.${cleaned}`);
    }
  }
  const blockList = getConfigBlock(config);
  if (blockList && blockList.length > 0) {
    for (const domain of blockList) {
      const cleaned = domain.replace(/^\*\./, "");
      hostRules.push(`MAP ${cleaned} 0.0.0.0`, `MAP *.${cleaned} 0.0.0.0`);
    }
  }
  if (hostRules.length > 0) {
    flags.push(`--host-resolver-rules=${hostRules.join(", ")}`);
  }

  flags.push(...MANDATORY_FLAGS);

  return flags;
}

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
      "  If you have a browser installed in a custom location, set it via: weavetab config browserPath \"/path/to/browser\""
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

  if (checkCircuitBreaker(profileDir)) {
    throw new Error(`[Weavetab] Circuit breaker triggered: Too many recent launch failures. Please wait ${CIRCUIT_BREAKER_RESET_MS / 1000}s before retrying.`);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) {
      logDebug(`[Weavetab] [!] Retrying browser launch (attempt ${attempt}/${MAX_ATTEMPTS}) after 1.5s...`);
      await writeLock({ pid: process.pid, port: 0, profileDir, browserPath: browser.path, mode: "session", pending: true, timestamp: Date.now() });
      await new Promise(r => setTimeout(r, 1500));
    }

    try {
      const enableExtension = getConfigExtension(config) !== false;
      let extPath = "";
      let normalizedExtPath = "";

      if (enableExtension) {
        extPath = path.resolve(__dirname, "../../ext-dist");
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

        normalizedExtPath = os.platform() === "win32"
          ? extPath.replace(/\//g, "\\")
          : extPath;
      } else {
        logDebug(`[Weavetab] Browser extension loading disabled via config (extension: false).`);
      }

      const resolvedDownloadDir = getDownloadDir(config) && getDownloadDir(config).trim()
        ? getDownloadDir(config).trim()
        : getOutputDir("downloads", config);

      const platform = os.platform();
      const normalizedProfileDir = platform === "win32"
        ? profileDir.replace(/\//g, "\\")
        : profileDir;
      const normalizedDownloadDir = platform === "win32"
        ? resolvedDownloadDir.replace(/\//g, "\\")
        : resolvedDownloadDir;

      const singletonLock = path.join(profileDir, "SingletonLock");
      const singletonCookie = path.join(profileDir, "SingletonCookie");
      try { if (fs.existsSync(singletonLock)) fs.unlinkSync(singletonLock); } catch { /* non-fatal */ }
      try { if (fs.existsSync(singletonCookie)) fs.unlinkSync(singletonCookie); } catch { /* non-fatal */ }

      if (enableExtension) {
        try {
          const swBase = path.join(profileDir, "Default", "Service Worker");
          const swScriptCache = path.join(swBase, "ScriptCache");
          const swDatabase = path.join(swBase, "Database");
          if (fs.existsSync(swScriptCache)) {
            fs.rmSync(swScriptCache, { recursive: true, force: true });
          }
          if (fs.existsSync(swDatabase)) {
            fs.rmSync(swDatabase, { recursive: true, force: true });
          }
        } catch (swErr) {
          logDebug(`[Weavetab] SW cache wipe failed (non-fatal): ${swErr}`);
        }
      }

      const args = [
        `--default-download-dir=${normalizedDownloadDir}`,
        ...getLaunchFlags(config, extPath),
        ...filterBrowserFlags(getConfigBrowserFlags(config) || []),
        ...(enableExtension ? [`--load-extension=${normalizedExtPath}`] : []),
        `--user-data-dir=${normalizedProfileDir}`,
        `--remote-debugging-port=${debugPort}`,
        "--remote-debugging-address=127.0.0.1",
        "about:blank",
      ];

      if (!isValidBrowserPath(browser.path)) {
        throw new Error(`Security violation: Invalid browser path: ${browser.path}`);
      }

      const proc = spawn(browser.path, args, {
        detached: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      proc.on("error", (err) => {
        logDebug(`[Weavetab] Browser spawn error: ${err.message}`);
      });
      proc.unref();
      (proc.stderr as any)?.unref?.();
      const pid = proc.pid;
      logDebug(`[Weavetab] Launching ${browser.name} (PID: ${pid}, port: auto, attempt: ${attempt}).`);

      let actualPort: number;
      try {
        actualPort = await resolvePortFromStderr(proc, pid, engine);
      } catch (portErr) {
        try { if (pid) killProcess(pid); } catch { /* ignore */ }
        clearLock();
        lastError = portErr instanceof Error ? portErr : new Error(String(portErr));
        logDebug(`[Weavetab] [!] Attempt ${attempt} failed to resolve port: ${lastError.message}`);
        continue;
      }

      const fingerprint = createBrowserFingerprint(pid || 0, actualPort, profileDir, browser.path);
      const fpPayload = {
        launchTimestamp: fingerprint.launchTimestamp,
      };

      await writeLock({
        pid,
        port: actualPort,
        profileDir,
        browserPath: browser.path,
        mode: "session",
        pending: true,
        timestamp: Date.now(),
        fingerprint: fpPayload,
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
      } else {
        logDebug(`[Weavetab] [OK] ${browser.name} ready on :${actualPort} (attempt ${attempt})`);

        if (enableExtension) {
          try {
            await new Promise(r => setTimeout(r, 1500));
            const testSession = await withCDPTimeout(CDP({ host: "127.0.0.1", port: actualPort }), 4000, "CDP connect");
            try {
              const { targetInfos } = await withCDPTimeout(testSession.Target.getTargets(), 4000, "getTargets");
              const extensionTargets = targetInfos.filter(t => t.type === "service_worker" || (t.type === "page" && t.url.startsWith("chrome-extension://")));
              if (extensionTargets.length > 0) {
                logDebug(`[Weavetab] [OK] Extension loaded - found ${extensionTargets.length} extension target(s)`);
              } else {
                logDebug(`[Weavetab] [!] Extension may not have loaded - no extension targets found.`);
              }
            } finally {
              await testSession.close().catch(() => {});
            }
          } catch (extCheckErr) {
            logDebug(`[Weavetab] [!] Could not verify extension load: ${extCheckErr}`);
          }
        }
      }

      await writeLock({
        pid,
        port: actualPort,
        profileDir,
        browserPath: browser.path,
        mode: "session",
        pending: false,
        timestamp: Date.now(),
        fingerprint: fpPayload,
      });
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
  if (engine === "webkit") {
    throw new Error("[Weavetab] WebKit CDP launch is not supported. Use browserType: 'chromium' or 'firefox'.");
  }

  const configuredPath = getConfigBrowserPath(config);
  let browser: { path: string; name: string } | null = null;
  if (configuredPath && configuredPath !== "auto" && (configuredPath.includes("/") || configuredPath.includes("\\")) && fs.existsSync(configuredPath) && isValidBrowserPath(configuredPath)) {
    browser = { name: "Firefox", path: path.resolve(configuredPath) };
  } else {
    browser = findFirefox();
  }

  if (!browser) {
    throw new Error(
      `[Weavetab] No firefox browser found.\n` +
      `  Install Firefox and try again.`
    );
  }

  const debugPort = 0;
  const profileDir = getSessionProfile(getConfigCookies(config), getConfigProfileDir(config), config.syncDataAcrossBrowsers, browser.path);

  const args: string[] = [];
  if (getConfigHeadless(config)) args.push("-headless");
  for (const f of filterBrowserFlags(getConfigBrowserFlags(config) || [])) {
    if (f && !args.includes(f)) args.push(f);
  }
  args.push(
    `--remote-debugging-port=${debugPort}`,
    "--profile", profileDir,
    "--new-tab", "about:blank"
  );

  const proc = spawn(browser.path, args, {
    detached: true,
    stdio: ["ignore", "ignore", "pipe"],
  });
  proc.on("error", (err) => {
    logDebug(`[Weavetab] Firefox spawn error: ${err.message}`);
  });
  proc.unref();
  (proc.stderr as any)?.unref?.();
  const pid = proc.pid;
  logDebug(`[Weavetab] Launching ${browser.name} (${engine}, PID: ${pid}, port: auto).`);

  const actualPort = await resolvePortFromStderr(proc, pid, engine);

  for (let i = 0; i < 15; i++) {
    try {
      await withCDPTimeout(CDP.List({ host: "127.0.0.1", port: actualPort }), 2000, "CDP.List nonChromium");
      logDebug(`[Weavetab] [OK] ${browser.name} ready on :${actualPort}`);
      await writeLock({ pid, port: actualPort, profileDir, browserPath: browser.path, mode: "session", pending: false, timestamp: Date.now() });
      return { path: browser.path, name: browser.name, port: actualPort, engine };
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  logDebug(`[Weavetab] [!] ${browser.name} not confirmed after 15s — proceeding with port ${actualPort}.`);
  await writeLock({ pid, port: actualPort, profileDir, browserPath: browser.path, mode: "session", pending: false, timestamp: Date.now() });
  return { path: browser.path, name: browser.name, port: actualPort, engine };
}

export async function injectStealthScript(session: CDP.Client): Promise<void> {
  try {
    await session.Page.addScriptToEvaluateOnNewDocument({ source: STEALTH_SCRIPT });
    await session.Runtime.evaluate({ expression: STEALTH_SCRIPT }).catch(() => {});
  } catch { /* ignore */ }
}

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
      const chunkStr = chunk.toString();
      stderrData += chunkStr;

      const lowerChunk = chunkStr.toLowerCase();
      if (lowerChunk.includes("extension") &&
        (lowerChunk.includes("error") ||
          lowerChunk.includes("failed") ||
          lowerChunk.includes("could not load"))) {
        logDebug(`[Weavetab] [!] Extension loading error detected in stderr: ${stderrData.slice(-500)}`);
      }

      const match = stderrData.match(/DevTools listening on ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]|[\d.]+):(\d+)/i);
      if (match && !resolved) {
        resolved = true;
        clearTimeout(timer);
        try { proc.stderr?.destroy(); } catch { /* ignore */ }
        const port = parseInt(match[1]!, 10);
        logDebug(`[Weavetab] [OK] Resolved dynamic port: ${port}`);
        resolve(port);
      }
    });

    proc.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        try { proc.stderr?.destroy(); } catch { /* ignore */ }
        clearLock();
        reject(new Error(`[Weavetab] Browser process spawn error: ${err.message}`));
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

export async function getFreePort(preferredPort = 9222): Promise<number> {
  const isAvailable = (p: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.once("listening", () => {
        s.close(() => resolve(true));
      });
      s.listen(p, "127.0.0.1");
    });
  };

  if (preferredPort > 0 && (await isAvailable(preferredPort))) {
    return preferredPort;
  }

  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.once("listening", () => {
      const addr = s.address();
      const p = typeof addr === "object" && addr ? addr.port : 9222;
      s.close(() => resolve(p));
    });
    s.listen(0, "127.0.0.1");
  });
}

export function testPortListening(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.connect(port, "127.0.0.1", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(false);
    });
  });
}

export async function launchElectronApp(
  appName: string,
  config: Config
): Promise<{ path: string; name: string; port: number; engine: "chromium"; isElectron: true }> {
  const appCfg = getElectronAppConfig(appName, config);
  if (!appCfg) {
    throw new Error(
      `[Weavetab] ✗ Electron app "${appName}" is not configured in config.json.\n` +
      `  Please add an entry under "electron": { "${appName}": "C:\\\\path\\\\to\\\\app.exe" } in your config.`
    );
  }

  if (appCfg.port && !appCfg.path) {
    const isAlive = await testPortListening(appCfg.port);
    if (isAlive) {
      logDebug(`[Weavetab] Attached to live Electron dev server on port ${appCfg.port}`);
      return { path: "dev-server", name: appName, port: appCfg.port, engine: "chromium", isElectron: true };
    }
    throw new Error(`[Weavetab] ✗ Electron dev app "${appName}" on port ${appCfg.port} is not responding. Ensure your dev server is running.`);
  }

  if (appCfg.url && !appCfg.path) {
    try {
      const parsed = new URL(appCfg.url);
      const port = parsed.port ? parseInt(parsed.port, 10) : (appCfg.port || 0);
      if (!port || port <= 0 || port > 65535) {
        throw new Error(`Dev URL "${appCfg.url}" must include an explicit CDP port (e.g. http://localhost:9222) or pair with "port".`);
      }
      const isAlive = await testPortListening(port);
      if (isAlive) {
        logDebug(`[Weavetab] Attached to live Electron app at ${appCfg.url} (port ${port})`);
        return { path: appCfg.url, name: appName, port, engine: "chromium", isElectron: true };
      }
      throw new Error(`[Weavetab] ✗ Electron dev app "${appName}" at ${appCfg.url} is not responding.`);
    } catch (e: any) {
      throw new Error(`[Weavetab] ✗ Invalid or unreachable dev URL for "${appName}": ${e?.message || e}`);
    }
  }

  const execPath = resolveElectronExecutablePath(appName, appCfg.path) || appCfg.path;
  if (!execPath || !isValidElectronExecutablePath(execPath)) {
    throw new Error(`[Weavetab] ✗ Invalid or non-existent Electron executable path for "${appName}": ${execPath}`);
  }

  const lock = readLock(appName);
  if (lock && lock.mode === "session") {
    if (isLockPending(lock)) {
      logDebug(`[Weavetab] Launch already in progress for ${appName} (PID: ${lock.pid}). Waiting...`);
      throw new Error(`Launch already in progress for ${appName}. Wait for it to complete.`);
    }
    const valid = await isLockValid(lock);
    if (valid) {
      logDebug(`[Weavetab] [OK] Reusing valid Electron lock for ${appName} (PID: ${lock.pid}, Port: ${lock.port})`);
      return { path: execPath, name: appName, port: lock.port, engine: "chromium", isElectron: true };
    }
    logDebug(`[Weavetab] [!] Stale lock detected for ${appName}. Clearing.`);
    clearLock(appName);
  } else if (lock) {
    clearLock(appName);
  }

  const profileDir = getElectronProfile(appName, appCfg.profileDir);
  const actualPort = appCfg.port && appCfg.port > 0 ? appCfg.port : await getFreePort(9222);

  const singletonLock = path.join(profileDir, "SingletonLock");
  const singletonCookie = path.join(profileDir, "SingletonCookie");
  try { if (fs.existsSync(singletonLock)) fs.unlinkSync(singletonLock); } catch { /* non-fatal */ }
  try { if (fs.existsSync(singletonCookie)) fs.unlinkSync(singletonCookie); } catch { /* non-fatal */ }

  const platform = os.platform();
  const normalizedProfileDir = platform === "win32"
    ? profileDir.replace(/\//g, "\\")
    : profileDir;

  const resolvedDownloadDir = getDownloadDir(config) && getDownloadDir(config).trim()
    ? getDownloadDir(config).trim()
    : getOutputDir("downloads", config);
  const normalizedDownloadDir = platform === "win32"
    ? resolvedDownloadDir.replace(/\//g, "\\")
    : resolvedDownloadDir;

  const userArgs = filterBrowserFlags(appCfg.args || []);
  const args = [
    `--default-download-dir=${normalizedDownloadDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...userArgs,
    `--user-data-dir=${normalizedProfileDir}`,
    `--remote-debugging-port=${actualPort}`,
    "--remote-debugging-address=127.0.0.1",
  ];
  if (getConfigHeadless(config) && !args.some(a => a === "--headless" || a.startsWith("--headless="))) {
    args.push("--headless=new");
  }

  const fingerprint = createBrowserFingerprint(process.pid, actualPort, profileDir, execPath);
  const fpPayload = {
    launchTimestamp: fingerprint.launchTimestamp,
  };

  await writeLock({
    pid: process.pid,
    port: actualPort,
    profileDir,
    browserPath: execPath,
    mode: "session",
    appName,
    pending: true,
    timestamp: Date.now(),
    fingerprint: fpPayload,
  }, appName);

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    XDG_CONFIG_HOME: profileDir,
    XDG_DATA_HOME: profileDir,
  };

  const proc = spawn(execPath, args, {
    detached: true,
    stdio: "ignore",
    env: childEnv,
  });
  proc.on("error", (err) => {
    logDebug(`[Weavetab] Electron spawn error (${appName}): ${err.message}`);
  });
  proc.unref();
  const pid = proc.pid;
  logDebug(`[Weavetab] Launching Electron app ${appName} (PID: ${pid}, port: ${actualPort}).`);

  let confirmed = false;
  for (let i = 0; i < 20; i++) {
    try {
      await withCDPTimeout(CDP.List({ host: "127.0.0.1", port: actualPort }), 1500, "CDP.List Electron");
      confirmed = true;
      break;
    } catch {
      await new Promise(r => setTimeout(r, 600));
    }
  }

  if (!confirmed) {
    const isListening = await testPortListening(actualPort);
    if (!isListening) {
      if (pid) killProcess(pid, true);
      clearLock(appName);
      throw new Error(`[Weavetab] Electron app ${appName} failed to start CDP listener on port ${actualPort} after 12s.`);
    }
  }

  await writeLock({
    pid,
    port: actualPort,
    profileDir,
    browserPath: execPath,
    mode: "session",
    appName,
    pending: false,
    timestamp: Date.now(),
    fingerprint: fpPayload,
  }, appName);

  return { path: execPath, name: appName, port: actualPort, engine: "chromium", isElectron: true };
}
