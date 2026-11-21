import { logDebug } from "../audit/logger.js";
import CDP from "chrome-remote-interface";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import type { Config } from "../config/loader.js";
import { getSessionProfile } from "./profiles.js";
import { getConfigCookies, getConfigProfileDir, getConfigBrowserPath } from "../config/loader.js";

const PROFILE_CACHE_MAX = 100;
const profileVerificationCache: Map<string, boolean> = new Map();

function profileCacheSet(key: string, value: boolean): void {
  if (profileVerificationCache.size >= PROFILE_CACHE_MAX && !profileVerificationCache.has(key)) {
    const firstKey = profileVerificationCache.keys().next().value;
    if (firstKey !== undefined) profileVerificationCache.delete(firstKey);
  }
  profileVerificationCache.set(key, value);
}

setInterval(() => { profileVerificationCache.clear(); }, 5 * 60_000).unref();

export async function verifyProfileIsolation(
  session: CDP.Client,
  config: Config,
  targetId: string
): Promise<{ verified: boolean; actualProfile?: string; expectedProfile: string }> {
  const cacheKey = targetId;

  if (profileVerificationCache.has(cacheKey)) {
    const cached = profileVerificationCache.get(cacheKey)!;
    const expectedProfile = getSessionProfile(getConfigCookies(config), getConfigProfileDir(config), config.syncDataAcrossBrowsers, getConfigBrowserPath(config));
    return { verified: cached, expectedProfile };
  }

  const expectedProfile = getSessionProfile(getConfigCookies(config), getConfigProfileDir(config), config.syncDataAcrossBrowsers, getConfigBrowserPath(config));

  try {
    await session.Browser.getVersion();

    const extensionCheck = await session.Runtime.evaluate({
      expression: "!!(window.__wt_session_id || window.__wt_config)",
      returnByValue: true,
    });

    const profileFromProcess = await getProfileFromProcess(session, config);

    const extensionLoaded = extensionCheck.result?.value === true;
    const profileMatches = profileFromProcess ? normalizePath(profileFromProcess) === normalizePath(expectedProfile) : false;
    const verified = extensionLoaded || profileMatches;

    profileCacheSet(cacheKey, verified);

    return {
      verified,
      actualProfile: profileFromProcess || undefined,
      expectedProfile,
    };
  } catch (error) {
    logDebug(`[Weavetab Security] Profile verification failed: ${error}`);
    profileCacheSet(cacheKey, false);
    return { verified: false, expectedProfile };
  }
}

export function clearProfileVerificationCache(targetId: string): void {
  profileVerificationCache.delete(targetId);
}

export interface BrowserFingerprint {
  pid: number;
  port: number;
  profileDir: string;
  browserPath: string;
  launchTimestamp: number;
  userAgent: string;
  cdpVersion: string;
}

export function createBrowserFingerprint(
  pid: number,
  port: number,
  profileDir: string,
  browserPath: string
): BrowserFingerprint {
  return {
    pid,
    port,
    profileDir,
    browserPath,
    launchTimestamp: Date.now(),
    userAgent: "",
    cdpVersion: "",
  };
}

export async function verifyBrowserFingerprint(
  session: CDP.Client,
  _expectedFingerprint: BrowserFingerprint
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const browserInfo = await session.Browser.getVersion();
    const userAgent = browserInfo.userAgent || "";
    const product = browserInfo.product || "";
    const combined = `${userAgent} ${product}`;
    if (!/Chrome|Chromium|Edge|Brave|Firefox|Mozilla/i.test(combined)) {
      return { valid: false, reason: "User agent does not match expected browser type" };
    }
    return { valid: true };
  } catch (error) {
    return { valid: false, reason: `Fingerprint verification failed: ${error}` };
  }
}

export function matchesUserDataDirInCmdLine(cmdLine: string, profileDir: string): boolean {
  if (!cmdLine || !profileDir) return false;
  const normCmd = cmdLine.toLowerCase();
  if (!normCmd.includes("--user-data-dir")) return false;

  const normProfile = normalizePath(profileDir).replace(/[\\/]+$/, "");
  const slashProfile = normProfile.replace(/\\/g, "/");
  const candidates = Array.from(new Set([normProfile, slashProfile]));

  for (const cand of candidates) {
    const escaped = cand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(
      `--user-data-dir(?:=|\\s+)(?:"${escaped}[\\\\/]?"|'${escaped}[\\\\/]?'|${escaped}[\\\\/]?(?=\\s|$|"|'))`,
      "i"
    );
    if (regex.test(normCmd)) return true;
  }
  return false;
}

const _killCooldown = new Map<string, number>();

export function safelyKillWeavetabProcesses(profileDir: string, expectedPid?: number): void {
  const now = Date.now();
  const last = _killCooldown.get(profileDir) ?? 0;
  if (now - last < 10_000) {
    logDebug(`[Weavetab Security] safelyKillWeavetabProcesses: cooldown active, skipping.`);
    return;
  }
  _killCooldown.set(profileDir, now);

  const plat = os.platform();

  try {
    if (plat === "win32") {
      const psResult = spawnSync("powershell", [
        "-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation"
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 });

      if (psResult.status === 0 && psResult.stdout) {
        const lines = psResult.stdout.split(/\r?\n/).slice(1);
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const match = trimmed.match(/^"?(\d+)"?,(.*)$/);
          if (!match) continue;
          const pid = parseInt(match[1]!, 10);
          let cmdLine = match[2] || "";
          if (cmdLine.startsWith('"') && cmdLine.endsWith('"')) {
            cmdLine = cmdLine.slice(1, -1).replace(/""/g, '"');
          }
          if (isNaN(pid) || pid <= 0 || pid === process.pid) continue;
          if (expectedPid !== undefined && pid !== expectedPid) continue;
          if (matchesUserDataDirInCmdLine(cmdLine, profileDir)) {
            spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore", timeout: 2000 });
            logDebug(`[Weavetab Security] Safely terminated Weavetab process: ${pid}`);
          }
        }
      }
    } else {
      const psResult = execSync("ps -ax -o pid= -o command=", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 });
      for (const line of psResult.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const spaceIdx = trimmed.indexOf(" ");
        if (spaceIdx === -1) continue;
        const pid = parseInt(trimmed.slice(0, spaceIdx), 10);
        const cmd = trimmed.slice(spaceIdx + 1);
        if (isNaN(pid) || pid <= 0 || pid === process.pid) continue;
        if (expectedPid !== undefined && pid !== expectedPid) continue;
        if (matchesUserDataDirInCmdLine(cmd, profileDir)) {
          try {
            process.kill(pid, "SIGKILL");
            logDebug(`[Weavetab Security] Safely terminated Weavetab process: ${pid}`);
          } catch { /* already gone */ }
        }
      }
    }
  } catch (error) {
    logDebug(`[Weavetab Security] Process killing failed (non-critical): ${error}`);
  }
}

function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase();
}

async function getProfileFromProcess(session: CDP.Client, _config: Config): Promise<string | null> {
  try {
    const evalRes = await session.Runtime.evaluate({
      expression: `
        (() => {
          try {
            if (window.__wt_profile_dir) return window.__wt_profile_dir;
            return null;
          } catch (e) {
            return null;
          }
        })()
      `,
      returnByValue: true,
    });

    return evalRes.result?.value || null;
  } catch {
    return null;
  }
}
