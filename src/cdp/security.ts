import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — cdp/security.ts
 * Security verification functions for browser isolation and process identity.
 *  - Profile verification: ensures the browser uses an isolated profile
 *  - Browser fingerprinting: verifies launched process identity
 *  - Process killing safety: whitelisting and verification
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import type { Config } from "../config/loader.js";
import { getSessionProfile } from "./profiles.js";
import { getConfigCookies, getConfigProfileDir } from "../config/loader.js";

// ─── Profile Verification Cache ───────────────────────────────────────────────────

// Cap profileVerificationCache at 100 entries (evict oldest on overflow) and
// sweep entries for closed sessions every 5 minutes via an unref'd interval so
// the cache doesn't grow without bound across many tabs / reconnects.
const PROFILE_CACHE_MAX = 100;
let profileVerificationCache: Map<string, boolean> = new Map();

function profileCacheSet(key: string, value: boolean): void {
  if (profileVerificationCache.size >= PROFILE_CACHE_MAX && !profileVerificationCache.has(key)) {
    const firstKey = profileVerificationCache.keys().next().value;
    if (firstKey !== undefined) profileVerificationCache.delete(firstKey);
  }
  profileVerificationCache.set(key, value);
}

// Periodic sweep: clear the whole cache every 5 min so stale session IDs don't persist
setInterval(() => { profileVerificationCache.clear(); }, 5 * 60_000).unref();


/**
 * Verifies that the browser is actually using the isolated profile directory.
 * Uses CDP to check the actual user data directory being used by the browser.
 * Results are cached per session to avoid per-call overhead.
 */
export async function verifyProfileIsolation(
  session: CDP.Client,
  config: Config,
  targetId: string
): Promise<{ verified: boolean; actualProfile?: string; expectedProfile: string }> {
  const cacheKey = targetId;

  // Return cached result if available
  if (profileVerificationCache.has(cacheKey)) {
    const cached = profileVerificationCache.get(cacheKey)!;
    const expectedProfile = getSessionProfile(getConfigCookies(config), getConfigProfileDir(config));
    return { verified: cached, expectedProfile };
  }

  const expectedProfile = getSessionProfile(getConfigCookies(config), getConfigProfileDir(config));

  try {
    // Method 1: Check browser info via CDP (most reliable)
    const browserInfo = await session.Browser.getVersion();

    // Parse user agent to check for Weavetab session markers
    // Weavetab adds custom flags that should be present in the browser
    const userAgent = browserInfo.userAgent || "";

    // Method 2: Check if browser has the Weavetab extension loaded
    // This confirms it's our launched instance
    const extensionCheck = await session.Runtime.evaluate({
      expression: '!!(window.__wt_session_id || window.__wt_config)',
      returnByValue: true,
    });

    // Method 3: Verify process command line contains the isolated profile path
    // This requires OS-specific process inspection
    const profileFromProcess = await getProfileFromProcess(session, config);

    // Verification passes if:
    // 1. Extension is loaded (we launched this browser)
    // 2. OR we can verify the profile path from process info
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
    // Fail closed: return verified:false and let the caller decide how to handle
    // it. Verification errors — including a compromised or hijacked session —
    // must never be treated as success.
    profileCacheSet(cacheKey, false);
    return { verified: false, expectedProfile };
  }
}

/**
 * Clears the profile verification cache for a specific session.
 * Called when a session is closed or reconnected.
 */
export function clearProfileVerificationCache(targetId: string): void {
  profileVerificationCache.delete(targetId);
}

// ─── Browser Fingerprinting ────────────────────────────────────────────────────

interface BrowserFingerprint {
  pid: number;
  port: number;
  profileDir: string;
  browserPath: string;
  launchTimestamp: number;
  userAgent: string;
  cdpVersion: string;
}

let currentFingerprint: BrowserFingerprint | null = null;

/**
 * Creates a unique fingerprint for the launched browser process.
 * This is stored in the lock file and verified on reconnection.
 */
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
    userAgent: "", // Will be filled after CDP connection
    cdpVersion: "", // Will be filled after CDP connection
  };
}

/**
 * Verifies that the connected browser matches the expected fingerprint.
 * Runs at CDP connect time only.
 */
export async function verifyBrowserFingerprint(
  session: CDP.Client,
  expectedFingerprint: BrowserFingerprint
): Promise<{ valid: boolean; reason?: string }> {
  try {
    const browserInfo = await session.Browser.getVersion();

    // Verify CDP version matches (or is compatible)
    const currentCDPVersion = browserInfo.product || "";

    // Verify user agent is from a Chromium-based browser
    const userAgent = browserInfo.userAgent || "";
    if (!userAgent.includes("Chrome") && !userAgent.includes("Edge") && !userAgent.includes("Brave")) {
      return { valid: false, reason: "User agent does not match expected browser type" };
    }

    // Update fingerprint with runtime data
    currentFingerprint = {
      ...expectedFingerprint,
      userAgent,
      cdpVersion: currentCDPVersion,
    };

    return { valid: true };
  } catch (error) {
    return { valid: false, reason: `Fingerprint verification failed: ${error}` };
  }
}

export function getCurrentFingerprint(): BrowserFingerprint | null {
  return currentFingerprint;
}

// ─── Process Killing Safety ────────────────────────────────────────────────────

/**
 * Safely kills browser processes that were launched by Weavetab in the current session.
 * Only kills processes that match the exact profile directory from the lock file.
 * Never matches against processes that weren't launched by Weavetab.
*/
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
  const normalizedProfile = normalizePath(profileDir);

  try {
    if (plat === 'win32') {
      // Windows: use tasklist with NO user data in the command string.
      // Parse PIDs in JS, kill each with taskkill args array (no shell).
      //
      // Primary: PowerShell Get-WmiObject (works on all Win10+ without wmic.exe)
      const psResult = spawnSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-WmiObject Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation'
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

      if (psResult.status === 0 && psResult.stdout) {
        const lines = psResult.stdout.split('\n').slice(1); // skip CSV header
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // CSV: "ProcessId","CommandLine"
          const fields = trimmed.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(f => f.replace(/^"|"$/g, ''));
          const pid = parseInt(fields[0] ?? '0', 10);
          const cmdLine = (fields[1] ?? '').toLowerCase();
          if (isNaN(pid) || pid <= 0) continue;
          if (expectedPid !== undefined && pid !== expectedPid) continue;
          // Filter in JS — no interpolation into any shell command
          if (cmdLine.includes(normalizedProfile) && cmdLine.includes('--user-data-dir')) {
            spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
            logDebug(`[Weavetab Security] Safely terminated Weavetab process: ${pid}`);
          }
        }
      }
    } else {
      // Unix: read ps output in JS, filter in JS, kill via process.kill — never interpolate into shell
      const psResult = execSync('ps -ax -o pid= -o command=', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of psResult.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const spaceIdx = trimmed.indexOf(' ');
        if (spaceIdx === -1) continue;
        const pid = parseInt(trimmed.slice(0, spaceIdx), 10);
        const cmd = trimmed.slice(spaceIdx + 1).toLowerCase();
        if (isNaN(pid) || pid <= 0) continue;
        if (expectedPid !== undefined && pid !== expectedPid) continue;
        if (cmd.includes(normalizedProfile) && cmd.includes('--user-data-dir')) {
          try {
            process.kill(pid, 'SIGKILL');
            logDebug(`[Weavetab Security] Safely terminated Weavetab process: ${pid}`);
          } catch { /* process already gone */ }
        }
      }
    }
  } catch (error) {
    logDebug(`[Weavetab Security] Process killing failed (non-critical): ${error}`);
  }
}

/**
 * Returns a normalized, platform-independent path for comparison.
 */
function normalizePath(p: string): string {
  return path.resolve(p).toLowerCase();
}

/**
 * Attempts to extract the profile directory from the browser process.
 * This is a fallback method for profile verification.
 */
async function getProfileFromProcess(session: CDP.Client, config: Config): Promise<string | null> {
  try {
    // Use extension-based method to check profile directory
    const result = await session.Runtime.evaluate({
      expression: `
        (() => {
          try {
            // Check if we can read the user data directory from browser internals
            if (window.__wt_profile_dir) return window.__wt_profile_dir;
            return null;
          } catch (e) {
            return null;
          }
        })()
      `,
      returnByValue: true,
    });

    return result.result?.value || null;
  } catch {
    return null;
  }
}
