import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { WEAVETAB_VERSION } from "../version.js";

const _require = createRequire(import.meta.url);
function getVersion(): string {
  try {
    return _require("../../package.json").version || WEAVETAB_VERSION;
  } catch {
    return WEAVETAB_VERSION;
  }
}

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

// The production remote URL — points to weavetab/registry on GitHub.
export const REGISTRY_URL =
  "https://raw.githubusercontent.com/weavetab/registry/main/verified.json";

// Local override: when this file exists at the root of the repo, we use it instead
// of the remote URL. This allows full offline/local testing.
const LOCAL_REGISTRY_PATH = join(__dirname, "..", "..", "..", "registry", "verified.json");

/** In-memory cache so we only fetch once per process. */
let _verifiedCache: Set<string> | null = null;
let _cacheExpiry = 0; // unix ms — refresh every 30 min in long-running processes
const CACHE_TTL_MS = 30 * 60 * 1000;

function extractPackageNames(rawList: unknown[]): Set<string> {
  const set = new Set<string>();
  for (const item of rawList) {
    if (typeof item === "string" && item.trim()) {
      set.add(item.trim());
    } else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (typeof obj.id === "string" && obj.id.trim()) set.add(obj.id.trim());
      if (typeof obj.name === "string" && obj.name.trim()) set.add(obj.name.trim());
      if (typeof obj.package === "string" && obj.package.trim()) set.add(obj.package.trim());
    }
  }
  return set;
}

function loadLocalRegistry(): Set<string> | null {
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
  const res = await fetch(REGISTRY_URL, {
    signal: AbortSignal.timeout(5000),
    headers: { "User-Agent": "Weavetab-Registry-Check/1.0" },
  });
  if (!res.ok) throw new Error(`registry fetch failed: ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.verified)) throw new Error("invalid registry format");
  return extractPackageNames(data.verified);
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
  verifiedPackages: Set<string>
): PluginTrustInfo {
  // Tier 1: Official — @weavetab/plugin-* packages are first-party and trusted.
  if (packageName.startsWith(OFFICIAL_PLUGIN_PREFIX)) {
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

/**
 * Checks if a package exists on the npm registry via a fast HEAD request.
 */
export async function checkNpmPackageExists(pkgName: string): Promise<boolean> {
  try {
    const encodedName = pkgName.startsWith("@")
      ? `@${encodeURIComponent(pkgName.slice(1))}`
      : encodeURIComponent(pkgName);
    const res = await fetch(`https://registry.npmjs.org/${encodedName}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
      headers: { "User-Agent": `Weavetab/${getVersion()}` },
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Resolves potential package candidates for an input name.
 * - If name is already explicitly scoped (starts with @), resolves directly.
 * - If short name is provided (e.g. "n8n-wt"), checks both:
 *     1. Official shortcut: @weavetab/plugin-<name>
 *     2. Community package: <name>
 */
export async function resolvePluginCandidates(
  inputName: string,
  verifiedPackages: Set<string>
): Promise<PluginCandidate[]> {
  const trimmed = inputName.trim();

  // If already full scoped package name, resolve directly
  if (trimmed.startsWith("@")) {
    const trust = resolvePluginTrust(trimmed, verifiedPackages);
    return [
      {
        packageName: trimmed,
        tier: trust.tier,
        label: trust.label,
        badge: trust.badge,
        tooltip: trust.tooltip,
        isOfficialShortcut: trimmed.startsWith(OFFICIAL_PLUGIN_PREFIX),
      },
    ];
  }

  const officialCandidateName = `${OFFICIAL_PLUGIN_PREFIX}${trimmed}`;
  const communityCandidateName = trimmed;

  // Check existence in verified registry or npm
  const [officialOnNpm, communityOnNpm] = await Promise.all([
    checkNpmPackageExists(officialCandidateName),
    checkNpmPackageExists(communityCandidateName),
  ]);

  const candidates: PluginCandidate[] = [];

  // 1. Check Official Candidate
  if (officialOnNpm) {
    const trust = resolvePluginTrust(officialCandidateName, verifiedPackages);
    candidates.push({
      packageName: officialCandidateName,
      tier: "official",
      label: "Official",
      badge: trust.badge,
      tooltip: "Official Weavetab plugin maintained by the core team",
      isOfficialShortcut: true,
    });
  }

  // 2. Check Community Candidate
  const isCommunityVerified = verifiedPackages.has(communityCandidateName);
  if (communityOnNpm || isCommunityVerified) {
    const trust = resolvePluginTrust(communityCandidateName, verifiedPackages);
    candidates.push({
      packageName: communityCandidateName,
      tier: trust.tier,
      label: trust.label,
      badge: trust.badge,
      tooltip: isCommunityVerified
        ? "Community plugin reviewed and listed in Weavetab verified registry"
        : "Third-party community package on npm",
      isOfficialShortcut: false,
    });
  }

  // If neither was confirmed on npm (e.g. offline / network timeout or private repo),
  // fallback to providing both possibilities as options
  if (candidates.length === 0) {
    const officialTrust = resolvePluginTrust(officialCandidateName, verifiedPackages);
    const communityTrust = resolvePluginTrust(communityCandidateName, verifiedPackages);

    candidates.push({
      packageName: officialCandidateName,
      tier: "official",
      label: "Official",
      badge: officialTrust.badge,
      tooltip: "Official Weavetab plugin shortcut",
      isOfficialShortcut: true,
    });

    candidates.push({
      packageName: communityCandidateName,
      tier: communityTrust.tier,
      label: communityTrust.label,
      badge: communityTrust.badge,
      tooltip: communityTrust.tooltip,
      isOfficialShortcut: false,
    });
  }

  return candidates;
}
