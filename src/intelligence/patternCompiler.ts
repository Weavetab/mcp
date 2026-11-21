import { logDebug } from "../audit/logger.js";
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import path from "path";
import fs from "fs";
import { getSystemMemorySitesDir } from "../config/loader.js";
import { SessionSecretTracker } from "../security/secrets.js";

export interface WorkflowStep {
  tool: string;
  target?: string;
  value?: string;
  extra?: Record<string, unknown>;
}

export interface WorkflowPattern {
  name: string;
  steps: WorkflowStep[];
  success_indicator?: string;
  entry?: string;
  avg_duration_ms?: number;
  reliability: number;
  strikes: number;
  last_verified: string;
  total_executions: number;
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
  origin: string;
  framework?: string;
  shadowDom?: boolean;
  captcha_frequency?: "none" | "rare" | "moderate" | "frequent";
  quirks: SiteQuirks;
  patterns: Record<string, WorkflowPattern>;
  updatedAt: string;
  visitCount: number;
}

const VOLATILE_PATTERNS: RegExp[] = [
  /\[class\*="[a-z0-9]+-[a-z0-9]+"\]/,
  /:nth-child\(\d+\)/,
  /\.\w{8,}[-_]\w{4,}/,
  /div > div > div > /,
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

function redactSecretDeep<T>(val: T, sessionId = "__global__"): T {
  if (val == null) return val;
  const step1 = SessionSecretTracker.redactValue(sessionId, val);
  if (typeof step1 === "string") {
    return SessionSecretTracker.redactAll(step1) as T;
  }
  if (Array.isArray(step1)) {
    return step1.map((item) => redactSecretDeep(item, sessionId)) as T;
  }
  if (typeof step1 === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(step1 as Record<string, unknown>)) {
      out[k] = redactSecretDeep(v, sessionId);
    }
    return out as T;
  }
  return step1;
}

function originToFilename(origin: string): string {
  const safe =
    origin
      .replace(/^https?:\/\//, "")
      .replace(/^\.+/, "")
      .replace(/\.\.+/g, "_")
      .replace(/[^a-zA-Z0-9.-]/g, "_")
      .replace(/^\.+/, "")
      .replace(/\.\.+/g, "_") || "unknown";
  return safe;
}

function siteProfilePath(origin: string): string {
  const sitesDir = getSystemMemorySitesDir();
  const file = `${originToFilename(origin)}.json`;
  const resolvedBase = path.resolve(sitesDir);
  const fullPath = path.resolve(resolvedBase, file);
  if (!fullPath.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Invalid site profile path for origin: ${origin}`);
  }
  return fullPath;
}

async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const payload = JSON.stringify(data, null, 2);
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, payload, "utf-8");
  try {
    await rename(tmp, filePath);
  } catch {
    await writeFile(filePath, payload, "utf-8");
    try {
      await unlink(tmp);
    } catch {}
  }
}

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

export async function saveSiteProfile(profile: SiteProfile): Promise<void> {
  const filePath = siteProfilePath(profile.origin);

  let base: SiteProfile | null = null;
  if (fs.existsSync(filePath)) {
    try {
      base = JSON.parse(await readFile(filePath, "utf-8")) as SiteProfile;
    } catch {}
  }

  const merged: SiteProfile = {
    ...base,
    ...profile,
    origin: profile.origin,
    patterns: { ...(base?.patterns ?? {}), ...profile.patterns },
    quirks: { ...(base?.quirks ?? {}), ...profile.quirks },
    visitCount: profile.visitCount ?? base?.visitCount ?? 0,
    updatedAt: new Date().toISOString(),
  };

  cacheSet(profile.origin, merged);
  await writeJsonAtomic(filePath, merged);
  logDebug(`[PatternCompiler] Saved site profile -> ${filePath}`);
}

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

  const stabilizedSteps = (incoming.steps ?? existing.steps).map((step) => {
    const stabilizedTarget = step.target ? stabilizeSelector(step.target) : undefined;
    const redactedValue = step.value !== undefined ? redactSecretDeep(step.value) : undefined;
    let extra = step.extra !== undefined ? redactSecretDeep(step.extra) : undefined;
    if (step.target && stabilizedTarget === undefined) {
      extra = { ...(extra ?? {}), fallback_target: step.target };
    }
    return {
      ...step,
      target: stabilizedTarget,
      ...(redactedValue !== undefined ? { value: redactedValue } : {}),
      ...(extra !== undefined ? { extra } : {}),
    };
  });

  const hasChanges =
    !profile.patterns[name] ||
    (incoming.steps !== undefined && JSON.stringify(stabilizedSteps) !== JSON.stringify(existing.steps)) ||
    (incoming.success_indicator !== undefined && incoming.success_indicator !== existing.success_indicator) ||
    (incoming.entry !== undefined && incoming.entry !== existing.entry);

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
    logDebug(`[PatternCompiler] Pattern "${patternName}" on ${origin} hit 3 strikes (reliability: ${updated.reliability})`);
  }

  await saveSiteProfile({
    ...(profile as SiteProfile),
    patterns: { ...profile.patterns, [patternName]: updated },
  });

  return updated;
}

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

export async function getPatternReliability(
  origin: string,
  patternName: string
): Promise<number> {
  const profile = await getSiteProfile(origin);
  if (!profile) return -1;
  return profile.patterns[patternName]?.reliability ?? -1;
}

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
      const p = profile.patterns[name]!;
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
