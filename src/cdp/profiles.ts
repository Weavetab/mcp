import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — cdp/profiles.ts
 * Isolated browser session profile resolution with real-browser protection guard.
 * Weavetab NEVER reads from or writes to the user's real browser profile.
 * Weavetab by fy2ne
 */
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { PLATFORM } from "../config/loader.js";

// ─── Real-browser profile isolation guard ────────────────────────────────────
// These are the known default user data directories for every major browser
// on all supported platforms. Weavetab will REFUSE to use any of these paths
// as a session profile. This is an enterprise-critical security guarantee.

const HOME = os.homedir();

// Platform-specific real browser paths
const REAL_BROWSER_PATHS: string[] = [];

if (PLATFORM === 'win32') {
  // Windows paths
  REAL_BROWSER_PATHS.push(
    path.join(HOME, "AppData", "Local", "Google", "Chrome", "User Data"),
    path.join(HOME, "AppData", "Local", "Microsoft", "Edge", "User Data"),
    path.join(HOME, "AppData", "Local", "BraveSoftware", "Brave-Browser", "User Data"),
    path.join(HOME, "AppData", "Roaming", "Mozilla", "Firefox", "Profiles"),
    path.join(HOME, "AppData", "Roaming", "Opera Software", "Opera Stable"),
    path.join(HOME, "AppData", "Local", "Vivaldi", "User Data")
  );
} else if (PLATFORM === 'darwin') {
  // macOS paths
  REAL_BROWSER_PATHS.push(
    path.join(HOME, "Library", "Application Support", "Google", "Chrome"),
    path.join(HOME, "Library", "Application Support", "Microsoft Edge"),
    path.join(HOME, "Library", "Application Support", "BraveSoftware", "Brave-Browser"),
    path.join(HOME, "Library", "Application Support", "Firefox", "Profiles"),
    path.join(HOME, "Library", "Application Support", "Vivaldi")
  );
} else {
  // Linux paths
  REAL_BROWSER_PATHS.push(
    path.join(HOME, ".config", "google-chrome"),
    path.join(HOME, ".config", "microsoft-edge"),
    path.join(HOME, ".config", "BraveSoftware", "Brave-Browser"),
    path.join(HOME, ".mozilla", "firefox"),
    path.join(HOME, ".config", "opera"),
    path.join(HOME, ".config", "vivaldi")
  );
}

/**
 * Asserts that the given profile directory is NOT a real browser profile.
 * Throws a clear security error if it matches any known real-browser path.
 * This prevents Weavetab from ever accidentally accessing user's saved passwords,
 * cookies, history, or personal data from their personal browser.
 */
function assertNotRealBrowserProfile(profileDir: string): void {
  const resolved = path.resolve(profileDir).toLowerCase();

  for (const realPath of REAL_BROWSER_PATHS) {
    const realResolved = path.resolve(realPath).toLowerCase();
    // Block exact match and any subdirectory of a real browser profile
    if (resolved === realResolved || resolved.startsWith(realResolved + path.sep)) {
      throw new Error(
        `[Weavetab] ✗ SECURITY BLOCK: The profileDir "${profileDir}" points to your real browser data.\n` +
        `  Weavetab will never read from or write to your personal browser profile.\n` +
        `  Please use a separate, empty directory or leave profileDir empty to use Weavetab's isolated profile.\n` +
        `  Real browser path detected: ${realPath}`
      );
    }
  }
}

// ─── Session profile resolver ─────────────────────────────────────────────────

export function getSessionProfile(cookies: boolean, customProfileDir?: string, syncDataAcrossBrowsers?: boolean, browserPath?: string): string {
  // If the user specified a custom profile directory, validate and use it
  if (customProfileDir && customProfileDir.trim()) {
    const resolved = path.resolve(customProfileDir.trim());

    // Enterprise safety: refuse to use real browser profiles
    assertNotRealBrowserProfile(resolved);

    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
      logDebug(`[Weavetab] ✓ Created custom profile directory: ${resolved}`);
    } else {
      logDebug(`[Weavetab] ✓ Using custom profile directory: ${resolved}`);
    }
    return resolved;
  }

  // Default: use Weavetab's fully isolated session profile
  // This directory is completely separate from the user's real browser data.
  let sessionProfile = path.join(HOME, ".weavetab-system", "session-profile");
  
  if (syncDataAcrossBrowsers === false && browserPath && browserPath !== "auto") {
    // Isolate profiles per browser executable path
    const hash = crypto.createHash("md5").update(browserPath).digest("hex").slice(0, 8);
    // e.g. .weavetab-system/session-profile-a1b2c3d4
    sessionProfile = path.join(HOME, ".weavetab-system", `session-profile-${hash}`);
  }

  // Defense-in-depth: even though the hardcoded path should never match a real
  // browser profile, validate it anyway (belt-and-suspenders).
  assertNotRealBrowserProfile(sessionProfile);

  if (!fs.existsSync(sessionProfile)) {
    fs.mkdirSync(sessionProfile, { recursive: true });
    logDebug(`[Weavetab] ✓ Browser isolation verified — new isolated profile at: ${sessionProfile}`);
  } else {
    logDebug(`[Weavetab] ✓ Browser isolation verified — using isolated profile at: ${sessionProfile}`);
  }

  return sessionProfile;
}

// ─── Electron App Profile Resolver & Safety Guard ─────────────────────────────

export function sanitizeAppName(appName: string): string {
  const cleaned = appName.trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return cleaned || "app";
}

// Real application data directories that should NEVER be used directly
const REAL_DESKTOP_APP_ROOTS: string[] = [];

if (PLATFORM === 'win32') {
  REAL_DESKTOP_APP_ROOTS.push(
    path.join(HOME, "AppData", "Roaming"),
    path.join(HOME, "AppData", "Local"),
    path.join(HOME, "AppData", "LocalLow")
  );
} else if (PLATFORM === 'darwin') {
  REAL_DESKTOP_APP_ROOTS.push(
    path.join(HOME, "Library", "Application Support"),
    path.join(HOME, "Library", "Saved Application State"),
    path.join(HOME, "Library", "Caches")
  );
} else {
  REAL_DESKTOP_APP_ROOTS.push(
    path.join(HOME, ".config"),
    path.join(HOME, ".local", "share"),
    path.join(HOME, ".cache")
  );
}

/**
 * Asserts that the given profile directory is NOT a real desktop app's native user data directory.
 * Throws a security block error if it matches root or subdirectory of standard app data paths.
 */
export function assertNotRealElectronProfile(profileDir: string, appName: string): void {
  const resolved = path.resolve(profileDir).toLowerCase();

  // First check against browser profiles
  assertNotRealBrowserProfile(resolved);

  // Check against native desktop app data roots
  for (const rootPath of REAL_DESKTOP_APP_ROOTS) {
    const rootResolved = path.resolve(rootPath).toLowerCase();
    
    // Direct matches or direct children in %APPDATA%/<appName>
    const appSpecificRealDir = path.join(rootResolved, sanitizeAppName(appName)).toLowerCase();
    if (resolved === appSpecificRealDir || resolved.startsWith(appSpecificRealDir + path.sep)) {
      throw new Error(
        `[Weavetab] ✗ SECURITY BLOCK: The profileDir "${profileDir}" points to your real ${appName} desktop app data.\n` +
        `  Weavetab will never read from or write to your personal desktop app data.\n` +
        `  Please use an isolated directory or let Weavetab manage ~/.weavetab-system/apps/${appName}/.\n` +
        `  Real app data path detected: ${appSpecificRealDir}`
      );
    }
  }
}

/**
 * Resolves the isolated profile directory for a specific Electron application.
 */
export function getElectronProfile(appName: string, customProfileDir?: string): string {
  const sanitized = sanitizeAppName(appName);

  if (customProfileDir && customProfileDir.trim()) {
    const resolved = path.resolve(customProfileDir.trim());
    assertNotRealElectronProfile(resolved, appName);

    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
      logDebug(`[Weavetab] ✓ Created custom Electron profile directory for ${appName}: ${resolved}`);
    } else {
      logDebug(`[Weavetab] ✓ Using custom Electron profile directory for ${appName}: ${resolved}`);
    }
    return resolved;
  }

  const appProfileDir = path.join(HOME, ".weavetab-system", "apps", sanitized);
  assertNotRealElectronProfile(appProfileDir, appName);

  if (!fs.existsSync(appProfileDir)) {
    fs.mkdirSync(appProfileDir, { recursive: true });
    logDebug(`[Weavetab] ✓ Created isolated Electron profile directory for ${appName}: ${appProfileDir}`);
  } else {
    logDebug(`[Weavetab] ✓ Using isolated Electron profile directory for ${appName}: ${appProfileDir}`);
  }

  return appProfileDir;
}


