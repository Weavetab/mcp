import { logDebug } from "../audit/logger.js";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { PLATFORM } from "../config/loader.js";

const HOME = os.homedir();

function resolveRealOrParent(targetPath: string): string {
  const abs = path.resolve(targetPath);
  const tailSegments: string[] = [];
  let cur = abs;

  while (true) {
    try {
      if (fs.existsSync(cur)) {
        const realBase = fs.realpathSync(cur);
        return tailSegments.length > 0 ? path.join(realBase, ...tailSegments.reverse()) : realBase;
      }
    } catch { /* keep walking up */ }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    tailSegments.push(path.basename(cur));
    cur = parent;
  }
  return abs;
}

function getRealBrowserPaths(): string[] {
  const paths: string[] = [];
  const localAppData = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
  const appData = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");

  if (PLATFORM === "win32") {
    const localRoots = Array.from(new Set([path.join(HOME, "AppData", "Local"), localAppData]));
    const roamingRoots = Array.from(new Set([path.join(HOME, "AppData", "Roaming"), appData]));

    for (const lr of localRoots) {
      paths.push(
        path.join(lr, "Google", "Chrome", "User Data"),
        path.join(lr, "Google", "Chrome Beta", "User Data"),
        path.join(lr, "Google", "Chrome SxS", "User Data"),
        path.join(lr, "Google", "Chrome Dev", "User Data"),
        path.join(lr, "Chromium", "User Data"),
        path.join(lr, "Microsoft", "Edge", "User Data"),
        path.join(lr, "Microsoft", "Edge Beta", "User Data"),
        path.join(lr, "Microsoft", "Edge Dev", "User Data"),
        path.join(lr, "Microsoft", "Edge SxS", "User Data"),
        path.join(lr, "BraveSoftware", "Brave-Browser", "User Data"),
        path.join(lr, "BraveSoftware", "Brave-Browser-Beta", "User Data"),
        path.join(lr, "BraveSoftware", "Brave-Browser-Nightly", "User Data"),
        path.join(lr, "Vivaldi", "User Data"),
        path.join(lr, "Arc", "User Data"),
        path.join(lr, "Packages", "TheBrowserCompany.Arc_ttt1ap7aakyb4", "LocalCache", "Local", "Arc", "User Data")
      );
    }
    for (const rr of roamingRoots) {
      paths.push(
        path.join(rr, "Mozilla", "Firefox", "Profiles"),
        path.join(rr, "Opera Software", "Opera Stable"),
        path.join(rr, "Opera Software", "Opera GX Stable")
      );
    }
  } else if (PLATFORM === "darwin") {
    const appSupport = path.join(HOME, "Library", "Application Support");
    paths.push(
      path.join(appSupport, "Google", "Chrome"),
      path.join(appSupport, "Google", "Chrome Beta"),
      path.join(appSupport, "Google", "Chrome Canary"),
      path.join(appSupport, "Google", "Chrome Dev"),
      path.join(appSupport, "Chromium"),
      path.join(appSupport, "Microsoft Edge"),
      path.join(appSupport, "Microsoft Edge Beta"),
      path.join(appSupport, "Microsoft Edge Dev"),
      path.join(appSupport, "Microsoft Edge Canary"),
      path.join(appSupport, "BraveSoftware", "Brave-Browser"),
      path.join(appSupport, "BraveSoftware", "Brave-Browser-Beta"),
      path.join(appSupport, "BraveSoftware", "Brave-Browser-Nightly"),
      path.join(appSupport, "Firefox", "Profiles"),
      path.join(appSupport, "Vivaldi"),
      path.join(appSupport, "com.operasoftware.Opera"),
      path.join(appSupport, "com.operasoftware.OperaGX"),
      path.join(appSupport, "Arc", "User Data"),
      path.join(appSupport, "Arc")
    );
  } else {
    const cfgRoots = Array.from(new Set([path.join(HOME, ".config"), xdgConfig]));
    for (const cr of cfgRoots) {
      paths.push(
        path.join(cr, "google-chrome"),
        path.join(cr, "google-chrome-beta"),
        path.join(cr, "google-chrome-unstable"),
        path.join(cr, "chromium"),
        path.join(cr, "microsoft-edge"),
        path.join(cr, "microsoft-edge-beta"),
        path.join(cr, "microsoft-edge-dev"),
        path.join(cr, "BraveSoftware", "Brave-Browser"),
        path.join(cr, "BraveSoftware", "Brave-Browser-Beta"),
        path.join(cr, "opera"),
        path.join(cr, "vivaldi")
      );
    }
    paths.push(path.join(HOME, ".mozilla", "firefox"));
  }

  return paths;
}

export function getRealDesktopAppRoots(): string[] {
  const roots: string[] = [];
  const localAppData = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
  const appData = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(HOME, ".config");
  const xdgData = process.env.XDG_DATA_HOME || path.join(HOME, ".local", "share");

  if (PLATFORM === "win32") {
    roots.push(
      path.join(HOME, "AppData", "Roaming"),
      path.join(HOME, "AppData", "Local"),
      path.join(HOME, "AppData", "LocalLow"),
      appData,
      localAppData
    );
  } else if (PLATFORM === "darwin") {
    roots.push(
      path.join(HOME, "Library", "Application Support"),
      path.join(HOME, "Library", "Saved Application State"),
      path.join(HOME, "Library", "Caches")
    );
  } else {
    roots.push(
      path.join(HOME, ".config"),
      path.join(HOME, ".local", "share"),
      path.join(HOME, ".cache"),
      xdgConfig,
      xdgData
    );
  }
  return Array.from(new Set(roots));
}

function isWeavetabIsolatedPath(resolvedPath: string): boolean {
  const norm = resolvedPath.toLowerCase();
  const sysRoot = resolveRealOrParent(path.join(HOME, ".weavetab-system")).toLowerCase();
  const wtRoot = resolveRealOrParent(path.join(HOME, ".weavetab")).toLowerCase();
  if (norm === sysRoot || norm.startsWith(sysRoot + path.sep)) return true;
  if (norm === wtRoot || norm.startsWith(wtRoot + path.sep)) return true;
  if (norm.includes(`${path.sep}.weavetab-system${path.sep}`) || norm.endsWith(`${path.sep}.weavetab-system`)) return true;
  if (norm.includes(`${path.sep}.weavetab${path.sep}`) || norm.endsWith(`${path.sep}.weavetab`)) return true;
  return false;
}

export function assertNotRealProfile(profileDir: string): void {
  const resolved = resolveRealOrParent(profileDir).toLowerCase();
  if (isWeavetabIsolatedPath(resolved)) return;

  for (const realPath of getRealBrowserPaths()) {
    const realResolved = resolveRealOrParent(realPath).toLowerCase();
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

export function assertNotRealBrowserProfile(profileDir: string): void {
  assertNotRealProfile(profileDir);
}

export function getSessionProfile(_cookies: boolean, customProfileDir?: string, syncDataAcrossBrowsers?: boolean, browserPath?: string): string {
  if (customProfileDir && customProfileDir.trim()) {
    const resolved = path.resolve(customProfileDir.trim());
    assertNotRealProfile(resolved);

    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
      logDebug(`[Weavetab] ✓ Created custom profile directory: ${resolved}`);
    } else {
      logDebug(`[Weavetab] ✓ Using custom profile directory: ${resolved}`);
    }
    return resolved;
  }

  let sessionProfile = path.join(HOME, ".weavetab-system", "session-profile");

  if (syncDataAcrossBrowsers === false && browserPath && browserPath !== "auto") {
    const hash = crypto.createHash("md5").update(browserPath).digest("hex").slice(0, 8);
    sessionProfile = path.join(HOME, ".weavetab-system", `session-profile-${hash}`);
  }

  assertNotRealProfile(sessionProfile);

  if (!fs.existsSync(sessionProfile)) {
    fs.mkdirSync(sessionProfile, { recursive: true });
    logDebug(`[Weavetab] ✓ Browser isolation verified — new isolated profile at: ${sessionProfile}`);
  } else {
    logDebug(`[Weavetab] ✓ Browser isolation verified — using isolated profile at: ${sessionProfile}`);
  }

  return sessionProfile;
}

export function sanitizeAppName(appName: string): string {
  const cleaned = appName.trim().replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
  return cleaned || "app";
}

export function assertNotRealElectronProfile(profileDir: string, appName: string): void {
  const resolved = resolveRealOrParent(profileDir).toLowerCase();
  if (isWeavetabIsolatedPath(resolved)) return;

  assertNotRealProfile(profileDir);

  const tmpRoot = resolveRealOrParent(os.tmpdir()).toLowerCase();
  if (resolved.startsWith(tmpRoot + path.sep)) return;

  for (const rootPath of getRealDesktopAppRoots()) {
    const rootResolved = resolveRealOrParent(rootPath).toLowerCase();
    if (resolved === rootResolved || resolved.startsWith(rootResolved + path.sep)) {
      throw new Error(
        `[Weavetab] ✗ SECURITY BLOCK: The profileDir "${profileDir}" points to your real ${appName} desktop app data.\n` +
        `  Weavetab will never read from or write to your personal desktop app data.\n` +
        `  Please use an isolated directory or let Weavetab manage ~/.weavetab-system/apps/${appName}/.\n` +
        `  Real app data path detected: ${rootPath}`
      );
    }
  }
}

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
