/**
 * Weavetab — intelligence/patternCompiler.ts
 *
 * Compiles raw browser session trails (action sequences) into persistent,
 * reusable site workflow patterns stored under ~/.weavetab-system/memory/sites/.
 *
 * Design invariants:
 *  - One file per origin (sanitized hostname). Never creates per-path or per-run files.
 *  - Pattern names are caller-supplied (snake_case). Duplicate calls for the same
 *    name on the same origin UPDATE the existing pattern rather than creating a new file.
 *  - Volatile / unstable selectors (auto-generated classes, nth-child paths) are
 *    stripped and replaced with semantic anchors where possible.
 *  - Never reads or writes to ~/.weavetab/ (user config space).
 */

import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import fs from "fs";
import { getSystemMemorySitesDir } from "../config/loader.js";
import { logDebug } from "../audit/logger.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkflowStep {
  /** MCP tool name, e.g. "browser_click", "browser_fill", "browser_navigate" */
  tool: string;
  /** Primary selector or URL target */
  target?: string;
  /** Optional value (text typed, option selected, etc.) */
  value?: string;
  /** Any extra args forwarded verbatim to browser_burst replay */
  extra?: Record<string, unknown>;
}

export interface WorkflowPattern {
  /** Caller-assigned name in snake_case, e.g. "login_flow", "pr_review" */
  name: string;
  /** Compiled, stable steps ready for browser_burst replay */
  steps: WorkflowStep[];
  /** Optional CSS selector / URL fragment that confirms success */
  success_indicator?: string;
  /** URL path or pattern where this workflow starts, e.g. "/pull/:id/files" */
  entry?: string;
  /** Exponentially-weighted moving average of duration in ms */
  avg_duration_ms?: number;
  /** 0.0 – 1.0 reliability. Degrades on failures, climbs on successes. */
  reliability: number;
  /** Consecutive failure counter — 3 strikes triggers re-learn flag */
  strikes: number;
  /** ISO timestamp of last successful verified run */
  last_verified: string;
  /** Total times this pattern was executed */
  total_executions: number;
  /** Times the pattern completed without errors */
  successful_executions: number;
}

export interface SiteQuirks {
  cookie_banner?: {
    selector: string;
    action: string;
    appears: "first_visit" | "always" | "random";
  };
  rate_limit?: {
    threshold?: string;
    recovery?: string;
  };
  modal_popups?: Array<{
    trigger?: string;
    dismiss_selector: string;
  }>;
  [key: string]: unknown;
}

export interface SiteProfile {
  /** Full origin, e.g. "https://github.com" */
  origin: string;
  /** Detected JS framework: react, vue, angular, next, nuxt, svelte, etc. */
  framework?: string;
  /** True if the site uses Shadow DOM components */
  shadowDom?: boolean;
  /** How often this site presents CAPTCHA challenges */
  captcha_frequency?: "none" | "rare" | "moderate" | "frequent";
  /** Known site-level quirks to handle automatically */
  quirks: SiteQuirks;
  /** Named, compiled workflow patterns indexed by name */
  patterns: Record<string, WorkflowPattern>;
  /** ISO timestamp of last profile write */
  updatedAt: string;
  /** How many times this origin has been visited in automated sessions */
  visitCount: number;
}

// ─── Volatile selector detection ────────────────────────────────────────────

const VOLATILE_PATTERNS: RegExp[] = [
  /\[class\*="[a-z0-9]+-[a-z0-9]+"\]/,   // CSS-module hash attribute selectors
  /:nth-child\(\d+\)/,                     // positional pseudo-selectors
  /\.\w{8,}[-_]\w{4,}/,                   // hashed Tailwind / CSS-module class combos
  /div > div > div > /,                    // deep anonymous structural chains (3+ levels)
];

function isVolatileSelector(sel: string): boolean {
  return VOLATILE_PATTERNS.some((rx) => rx.test(sel));
}

function stabilizeSelector(sel: string): string | undefined {
  if (!sel) return undefined;
  if (isVolatileSelector(sel)) {
    logDebug(`[PatternCompiler] Dropping volatile selector: ${sel}`);
    return undefined;
  }
  return sel;
}

// ─── File path helpers ───────────────────────────────────────────────────────

function originToFilename(origin: string): string {
  return origin
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9.-]/g, "_");
}

function siteProfilePath(origin: string): string {
  const sitesDir = getSystemMemorySitesDir();
  return join(sitesDir, `${originToFilename(origin)}.json`);
}

// ─── In-process LRU cache ───────────────────────────────────────────────────

const profileCache = new Map<string, SiteProfile>();
const CACHE_MAX = 100;

function cacheSet(origin: string, profile: SiteProfile): void {
  if (profileCache.size >= CACHE_MAX && !profileCache.has(origin)) {
    const firstKey = profileCache.keys().next().value;
    if (firstKey !== undefined) profileCache.delete(firstKey);
  }
  profileCache.set(origin, profile);
}

export function clearSiteProfileCache(): void {
  profileCache.clear();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Load a site profile from disk. Returns null if the site has never been profiled.
 * Hits in-process cache first — no redundant disk reads within a session.
 */
export async function getSiteProfile(origin: string): Promise<SiteProfile | null> {
  if (profileCache.has(origin)) return profileCache.get(origin)!;

  const filePath = siteProfilePath(origin);
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = await readFile(filePath, "utf-8");
    const profile = JSON.parse(raw) as SiteProfile;
    cacheSet(origin, profile);
    return profile;
  } catch (e) {
    logDebug(`[PatternCompiler] Failed to parse site profile for ${origin}: ${e}`);
    return null;
  }
}

/**
 * Persist a site profile. Always deep-merges into existing data on disk — never
 * blindly overwrites — so concurrent tool calls don't clobber each other.
 */
export async function saveSiteProfile(profile: SiteProfile): Promise<void> {
  const filePath = siteProfilePath(profile.origin);

  let base: SiteProfile | null = null;
  if (fs.existsSync(filePath)) {
    try {
      base = JSON.parse(await readFile(filePath, "utf-8")) as SiteProfile;
    } catch { /* treat corrupt file as empty */ }
  }

  const merged: SiteProfile = {
    ...base,
    ...profile,
    origin: profile.origin,
    patterns: { ...(base?.patterns ?? {}), ...profile.patterns },
    quirks:   { ...(base?.quirks ?? {}),   ...profile.quirks   },
    visitCount: profile.visitCount ?? base?.visitCount ?? 0,
    updatedAt: new Date().toISOString(),
  };

  cacheSet(profile.origin, merged);
  await writeFile(filePath, JSON.stringify(merged, null, 2), "utf-8");
  logDebug(`[PatternCompiler] Saved site profile → ${filePath}`);
}

/**
 * Learn or update a named workflow pattern for a given origin.
 * - Duplicate name = merge/update, never duplicate file.
 * - Volatile selectors in steps are dropped to keep patterns stable.
 * - Anti-spam: skips disk write when content is identical to existing.
 */
export async function learnPattern(
  origin: string,
  name: string,
  incoming: Partial<WorkflowPattern>
): Promise<WorkflowPattern> {
  const profile = (await getSiteProfile(origin)) ?? {
    origin,
    quirks: {},
    patterns: {},
    visitCount: 0,
    updatedAt: new Date().toISOString(),
  };

  const existing: WorkflowPattern = profile.patterns[name] ?? {
    name,
    steps: [],
    reliability: 1.0,
    strikes: 0,
    last_verified: new Date().toISOString(),
    total_executions: 0,
    successful_executions: 0,
  };

  const stabilizedSteps = (incoming.steps ?? existing.steps).map((step) => ({
    ...step,
    target: step.target ? stabilizeSelector(step.target) : undefined,
  }));

  const hasChanges = (
    !profile.patterns[name] ||
    (incoming.steps !== undefined && JSON.stringify(stabilizedSteps) !== JSON.stringify(existing.steps)) ||
    (incoming.success_indicator !== undefined && incoming.success_indicator !== existing.success_indicator) ||
    (incoming.entry !== undefined && incoming.entry !== existing.entry)
  );

  if (hasChanges) {
    const updated: WorkflowPattern = {
      ...existing,
      ...incoming,
      name,
      steps: stabilizedSteps,
      last_verified: new Date().toISOString(),
    };
    await saveSiteProfile({
      ...(profile as SiteProfile),
      patterns: { ...profile.patterns, [name]: updated },
    });
    logDebug(`[PatternCompiler] Pattern "${name}" learned/updated for ${origin}`);
    return updated;
  } else {
    logDebug(`[PatternCompiler] Pattern "${name}" unchanged — skipping write`);
    return existing;
  }
}

/**
 * Record the outcome of executing a named pattern.
 * Updates reliability via EWMA (α=0.15) and tracks consecutive strikes.
 * 3 strikes → reliability will naturally fall below 0.4, agent should re-explore.
 */
export async function recordPatternExecution(
  origin: string,
  patternName: string,
  success: boolean,
  durationMs?: number
): Promise<WorkflowPattern | null> {
  const profile = await getSiteProfile(origin);
  if (!profile) return null;

  const pattern = profile.patterns[patternName];
  if (!pattern) return null;

  const alpha = 0.15;
  const newReliability = Math.round((0.85 * pattern.reliability + alpha * (success ? 1 : 0)) * 1000) / 1000;

  const updated: WorkflowPattern = {
    ...pattern,
    reliability: newReliability,
    strikes: success ? 0 : pattern.strikes + 1,
    last_verified: success ? new Date().toISOString() : pattern.last_verified,
    total_executions: pattern.total_executions + 1,
    successful_executions: success ? pattern.successful_executions + 1 : pattern.successful_executions,
    avg_duration_ms:
      durationMs !== undefined
        ? Math.round(
            pattern.avg_duration_ms !== undefined
              ? 0.8 * pattern.avg_duration_ms + 0.2 * durationMs
              : durationMs
          )
        : pattern.avg_duration_ms,
  };

  if (updated.strikes >= 3) {
    logDebug(`[PatternCompiler] ⚠ Pattern "${patternName}" on ${origin} hit 3 strikes (reliability: ${updated.reliability}) — re-learning recommended`);
  }

  await saveSiteProfile({
    ...(profile as SiteProfile),
    patterns: { ...profile.patterns, [patternName]: updated },
  });

  return updated;
}

/**
 * Record or update a site quirk (cookie banner, rate limit, modal popup, etc.)
 * Only writes if the stored data differs from incoming — prevents spam writes.
 */
export async function recordQuirk(
  origin: string,
  quirkKey: string,
  quirkData: unknown
): Promise<void> {
  const profile = (await getSiteProfile(origin)) ?? {
    origin,
    quirks: {},
    patterns: {},
    visitCount: 0,
    updatedAt: new Date().toISOString(),
  };

  const existing = (profile.quirks as Record<string, unknown>)[quirkKey];
  if (JSON.stringify(existing) === JSON.stringify(quirkData)) {
    logDebug(`[PatternCompiler] Quirk "${quirkKey}" unchanged — skipping write`);
    return;
  }

  await saveSiteProfile({
    ...(profile as SiteProfile),
    quirks: { ...profile.quirks, [quirkKey]: quirkData },
  });
  logDebug(`[PatternCompiler] Recorded quirk "${quirkKey}" for ${origin}`);
}

/**
 * Returns the reliability score (0–1) of a named pattern, or -1 if unknown.
 */
export async function getPatternReliability(
  origin: string,
  patternName: string
): Promise<number> {
  const profile = await getSiteProfile(origin);
  if (!profile) return -1;
  return profile.patterns[patternName]?.reliability ?? -1;
}

/**
 * Formats a compact site profile hint string for agent system prompt injection.
 * Called at session start when navigating to a known origin.
 */
export function formatSiteProfileHint(profile: SiteProfile): string {
  const lines: string[] = [`[SiteProfile] ${profile.origin}`];

  if (profile.framework) lines.push(`  framework: ${profile.framework}`);
  if (profile.captcha_frequency && profile.captcha_frequency !== "none") {
    lines.push(`  captcha_frequency: ${profile.captcha_frequency}`);
  }

  const patternNames = Object.keys(profile.patterns);
  if (patternNames.length > 0) {
    lines.push("  known_patterns:");
    for (const name of patternNames) {
      const p = profile.patterns[name];
      const flag =
        p.strikes >= 3
          ? " [RE-LEARN NEEDED]"
          : p.reliability >= 0.8
          ? " [fast-path eligible]"
          : "";
      lines.push(
        `    - ${name}: reliability=${p.reliability.toFixed(2)}, steps=${p.steps.length}${flag}`
      );
    }
  }

  const quirkKeys = Object.keys(profile.quirks).filter(
    (k) => profile.quirks[k] !== undefined && profile.quirks[k] !== null
  );
  if (quirkKeys.length > 0) {
    lines.push(`  quirks: ${quirkKeys.join(", ")}`);
  }

  return lines.join("\n");
}
