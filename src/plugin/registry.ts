import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { WEAVETAB_VERSION } from "../version.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export type PluginTrustTier = "official" | "verified" | "unverified";

export interface PluginTrustInfo {
  tier: PluginTrustTier;
  /** Terminal badge string for startup logs & CLI */
  badge: string;
  /** Human-readable label (e.g. Official, Verified, Unverified) */
  label: string;
  /** Description or tooltip text */
  tooltip: string;
}

export interface PluginCandidate {
  packageName: string;
  tier: PluginTrustTier;
  label: string;
  badge: string;
  tooltip: string;
  isOfficialShortcut: boolean;
  version?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Verification Registry
// ---------------------------------------------------------------------------

export const OFFICIAL_PLUGIN_PREFIX = "@weavetab/plugin-";

export const OFFICIAL_PACKAGES = new Set<string>([
  "@weavetab/plugin-foo",
  "@weavetab/plugin-devtools",
  "@weavetab/plugin-accessibility",
  "@weavetab/plugin-security",
  "@weavetab/plugin-recorder",
  "@weavetab/plugin-performance",
  "@weavetab/plugin-n8n",
  "@weavetab/plugin-notion",
  "@weavetab/plugin-github",
]);

// The production remote URLs — weavetab.dev (D1-backed) primary, GitHub raw fallback.
export const REGISTRY_URL = "https://weavetab.dev/api/registry/verified.json";

export const REGISTRY_FALLBACK_URL =
  "https://raw.githubusercontent.com/weavetab/registry/main/verified.json";

const LOCAL_REGISTRY_PATH = join(__dirname, "..", "..", "..", "registry", "verified.json");

let _verifiedCache: Set<string> | null = null;
let _cacheExpiry = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;

export function extractPackageNames(rawList: unknown[]): Set<string> {
  const set = new Set<string>();
  for (const item of rawList) {
    if (typeof item === "string" && item.trim()) {
      set.add(item.trim());
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (typeof obj.package === "string" && obj.package.trim()) {
        set.add(obj.package.trim());
      } else if (typeof obj.name === "string" && obj.name.trim()) {
        set.add(obj.name.trim());
      }
    }
  }
  return set;
}

function loadLocalRegistry(): Set<string> | null {
  if (process.env.WT_LOCAL_REGISTRY !== "1") return null;
  if (!existsSync(LOCAL_REGISTRY_PATH)) return null;
  try {
    const raw = readFileSync(LOCAL_REGISTRY_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (Array.isArray(data.verified)) {
      return extractPackageNames(data.verified);
    }
  } catch { /* malformed file */ }
  return null;
}

async function fetchRemoteRegistry(): Promise<Set<string>> {
  for (const url of [REGISTRY_URL, REGISTRY_FALLBACK_URL]) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        headers: { "User-Agent": "Weavetab-Registry-Check/1.0" },
      });
      if (!res.ok) continue;
      const data = await res.json();
      if (!Array.isArray(data.verified)) continue;
      return extractPackageNames(data.verified);
    } catch {
      continue;
    }
  }
  throw new Error("registry fetch failed: all sources unreachable");
}

/**
 * Returns the set of verified package names.
 * - Tries local registry/verified.json first (dev/test mode).
 * - Falls back to GitHub remote.
 * - Falls back to empty set on any failure (fail open — just shows unverified).
 */
export async function getVerifiedPackages(): Promise<Set<string>> {
  if (_verifiedCache && Date.now() < _cacheExpiry) return _verifiedCache;

  // 1. Local override (testing mode)
  const local = loadLocalRegistry();
  if (local) {
    _verifiedCache = local;
    _cacheExpiry = Date.now() + CACHE_TTL_MS;
    return local;
  }

  // 2. Remote registry
  try {
    const remote = await fetchRemoteRegistry();
    _verifiedCache = remote;
    _cacheExpiry = Date.now() + CACHE_TTL_MS;
    return remote;
  } catch {
    // 3. Fail open — return whatever we had before (or empty)
    return _verifiedCache ?? new Set();
  }
}

/**
 * Clear in-memory verified packages cache (useful for tests or forced refresh).
 */
export function invalidateRegistryCache(): void {
  _verifiedCache = null;
  _cacheExpiry = 0;
}

// ---------------------------------------------------------------------------
// Trust Resolution
// ---------------------------------------------------------------------------

/**
 * Determine the trust tier for a plugin based on its package name and the
 * verified registry.
 */
export function resolvePluginTrust(
  packageName: string,
  verifiedPackages: Set<string>,
  pkgDir?: string
): PluginTrustInfo {
  const normDir = pkgDir ? pkgDir.replace(/\\/g, "/") : "";
  const isNodeModulesProvenance = !pkgDir || normDir.includes("/node_modules/@weavetab/plugin-");
  const isOfficialVerified = OFFICIAL_PACKAGES.has(packageName) || verifiedPackages.has(packageName);

  if (packageName.startsWith(OFFICIAL_PLUGIN_PREFIX) && isNodeModulesProvenance && isOfficialVerified) {
    return {
      tier: "official",
      label: "Official",
      badge: "\u001b[1;44m \u271a \u001b[0m\u001b[34m [Official]\u001b[0m",
      tooltip: "Made by the Weavetab team. Fully trusted and audited.",
    };
  }

  // Tier 2: Verified community — listed in the registry.
  if (verifiedPackages.has(packageName)) {
    return {
      tier: "verified",
      label: "Verified",
      badge: "\u001b[1;42m \u2714 \u001b[0m\u001b[32m [Verified]\u001b[0m",
      tooltip: "Community-verified plugin. Reviewed and approved by Weavetab.",
    };
  }

  // Tier 3: Unverified — unknown origin / community package.
  return {
    tier: "unverified",
    label: "Unverified",
    badge: "\u001b[1;43m \u26a0 \u001b[0m\u001b[33m [Unverified]\u001b[0m",
    tooltip: "This plugin has not been verified by Weavetab. Review its permissions carefully.",
  };
}

// ---------------------------------------------------------------------------
// NPM Registry Existence & Candidate Resolution
// ---------------------------------------------------------------------------

export function encodeNpmPackageName(pkgName: string): string {
  return pkgName.startsWith("@")
    ? `@${encodeURIComponent(pkgName.slice(1))}`
    : encodeURIComponent(pkgName);
}

export function stripNpmVersion(spec: string): { name: string; version?: string } {
  const trimmed = spec.trim();
  const atIdx = trimmed.startsWith("@") ? trimmed.indexOf("@", 1) : trimmed.indexOf("@");
  if (atIdx <= 0) return { name: trimmed };
  return { name: trimmed.slice(0, atIdx), version: trimmed.slice(atIdx + 1) || undefined };
}

export async function checkNpmPackageExists(pkgName: string): Promise<boolean> {
  try {
    const { name } = stripNpmVersion(pkgName);
    const res = await fetch(`https://registry.npmjs.org/${encodeNpmPackageName(name)}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
      headers: { "User-Agent": `Weavetab/${WEAVETAB_VERSION}` },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function resolvePluginCandidates(
  inputName: string,
  verifiedPackages: Set<string>
): Promise<PluginCandidate[]> {
  const { name: baseName, version } = stripNpmVersion(inputName);
  const withVer = (pkg: string) => (version ? `${pkg}@${version}` : pkg);

  if (baseName.startsWith("@")) {
    const trust = resolvePluginTrust(baseName, verifiedPackages);
    return [
      {
        packageName: withVer(baseName),
        tier: trust.tier,
        label: trust.label,
        badge: trust.badge,
        tooltip: trust.tooltip,
        isOfficialShortcut: baseName.startsWith(OFFICIAL_PLUGIN_PREFIX),
      },
    ];
  }

  const officialBase = `${OFFICIAL_PLUGIN_PREFIX}${baseName}`;
  const communityBase = baseName;

  const [officialOnNpm, communityOnNpm] = await Promise.all([
    checkNpmPackageExists(officialBase),
    checkNpmPackageExists(communityBase),
  ]);

  const candidates: PluginCandidate[] = [];

  if (officialOnNpm) {
    const trust = resolvePluginTrust(officialBase, verifiedPackages);
    candidates.push({
      packageName: withVer(officialBase),
      tier: trust.tier,
      label: trust.label,
      badge: trust.badge,
      tooltip: "Official Weavetab plugin maintained by the core team",
      isOfficialShortcut: true,
    });
  }

  const isCommunityVerified = verifiedPackages.has(communityBase);
  if (communityOnNpm || isCommunityVerified) {
    const trust = resolvePluginTrust(communityBase, verifiedPackages);
    candidates.push({
      packageName: withVer(communityBase),
      tier: trust.tier,
      label: trust.label,
      badge: trust.badge,
      tooltip: isCommunityVerified
        ? "Community plugin reviewed and listed in Weavetab verified registry"
        : "Third-party community package on npm",
      isOfficialShortcut: false,
    });
  }

  // offline / timeout fallback: surface both options
  if (candidates.length === 0) {
    const officialTrust = resolvePluginTrust(officialBase, verifiedPackages);
    const communityTrust = resolvePluginTrust(communityBase, verifiedPackages);

    candidates.push({
      packageName: withVer(officialBase),
      tier: officialTrust.tier,
      label: officialTrust.label,
      badge: officialTrust.badge,
      tooltip: "Official Weavetab plugin shortcut",
      isOfficialShortcut: true,
    });

    candidates.push({
      packageName: withVer(communityBase),
      tier: communityTrust.tier,
      label: communityTrust.label,
      badge: communityTrust.badge,
      tooltip: communityTrust.tooltip,
      isOfficialShortcut: false,
    });
  }

  return candidates;
}
