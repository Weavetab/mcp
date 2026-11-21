import { logDebug } from "../audit/logger.js";
import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import path, { join } from "path";
import CDP from "chrome-remote-interface";
import { GLOBAL_CONFIG_DIR, getSystemDir } from "../config/loader.js";
import fs from "fs";

export type FailureType = "DEAD_SELECTOR" | "ACTION_FAILED";

export interface SelectorFingerprint {
  tag?: string;
  classes?: string[];
  role?: string;
  relativeTo?: string;
  structuralIdiom?: string;
}

export interface MemoryEntry {
  intent: string;
  selector: string;
  urlPath?: string;
  fingerprint?: SelectorFingerprint;
  successCount: number;
  failureCount: number;
  consecutiveFailures: number;
  lastSuccessVisit: number;
  state: "active" | "drift_detected" | "deprecated";
}

export interface NegativeMemoryEntry {
  selector: string;
  urlPath?: string;
  failureType: FailureType;
  expiredAtVisit: number;
}

export interface DomainProfile {
  domainFamily?: string;
  strategies: string[];
  memories: MemoryEntry[];
  failedSelectors: NegativeMemoryEntry[];
  shadowDom: boolean;
  framework?: string;
  updatedAt: string;
  visitCount: number;
}

const MAX_MEMORIES = 50;
const MAX_FAILED_SELECTORS = 50;

function sanitizeDomainFilename(hostname: string, baseDir: string): string {
  const safe =
    hostname
      .replace(/^\.+/, "")
      .replace(/\.\.+/g, "_")
      .replace(/[^a-zA-Z0-9.-]/g, "_")
      .replace(/^\.+/, "")
      .replace(/\.\.+/g, "_") || "unknown";
  const file = `${safe}.json`;
  const resolvedBase = path.resolve(baseDir);
  const fullPath = path.resolve(resolvedBase, file);
  if (!fullPath.startsWith(resolvedBase + path.sep)) {
    throw new Error(`Invalid domain path for hostname: ${hostname}`);
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

function domainFile(hostname: string): string {
  const memoryDir = getSystemDir("memory");
  const systemPath = sanitizeDomainFilename(hostname, memoryDir);
  const legacyDir = join(GLOBAL_CONFIG_DIR, "memory");
  const legacyPath = sanitizeDomainFilename(hostname, legacyDir);

  if (!fs.existsSync(systemPath) && fs.existsSync(legacyPath)) {
    try {
      fs.copyFileSync(legacyPath, systemPath);
    } catch {}
  }

  return systemPath;
}

const memoryCache = new Map<string, DomainProfile>();
const MEMORY_CACHE_MAX = 200;

export function clearMemoryCache(): void {
  memoryCache.clear();
}

export function getDomainFilePath(hostname: string): string {
  return domainFile(hostname);
}

function memoryCacheSet(hostname: string, profile: DomainProfile): void {
  if (memoryCache.size >= MEMORY_CACHE_MAX && !memoryCache.has(hostname)) {
    const firstKey = memoryCache.keys().next().value;
    if (firstKey !== undefined) memoryCache.delete(firstKey);
  }
  memoryCache.set(hostname, profile);
}

export async function loadDomainProfile(hostname: string): Promise<DomainProfile | null> {
  if (memoryCache.has(hostname)) {
    return memoryCache.get(hostname)!;
  }
  try {
    const content = await readFile(domainFile(hostname), "utf-8");
    const profile = JSON.parse(content) as DomainProfile;

    profile.failedSelectors = (profile.failedSelectors || []).filter(
      (neg) => profile.visitCount < neg.expiredAtVisit
    );

    for (const mem of profile.memories || []) {
      const visitsSinceSuccess = profile.visitCount - mem.lastSuccessVisit;

      if (mem.consecutiveFailures >= 3 && mem.successCount > 5) {
        mem.state = "drift_detected";
      } else if (visitsSinceSuccess > 20) {
        if (mem.state !== "deprecated") {
          mem.state = "active";
        }
      }
    }

    memoryCacheSet(hostname, profile);
    return profile;
  } catch {
    return null;
  }
}

export async function saveDomainProfile(
  hostname: string,
  updates: Partial<DomainProfile>
): Promise<DomainProfile> {
  const existing = await loadDomainProfile(hostname);
  const visitCount = updates.visitCount ?? existing?.visitCount ?? 0;

  const profile: DomainProfile = {
    strategies: [],
    memories: [],
    failedSelectors: [],
    shadowDom: false,
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
    visitCount,
  };

  if (updates.strategies) {
    profile.strategies = Array.from(new Set([...(existing?.strategies || []), ...updates.strategies]));
  }

  if (profile.memories.length > MAX_MEMORIES) {
    profile.memories = profile.memories.slice(-MAX_MEMORIES);
  }
  if (profile.failedSelectors.length > MAX_FAILED_SELECTORS) {
    profile.failedSelectors = profile.failedSelectors.slice(-MAX_FAILED_SELECTORS);
  }

  memoryCacheSet(hostname, profile);

  let dataPoints = profile.failedSelectors.length;
  for (const mem of profile.memories) {
    dataPoints += mem.successCount + mem.failureCount;
  }

  const targetFile = domainFile(hostname);
  if (dataPoints >= 3 || updates.visitCount !== undefined || fs.existsSync(targetFile)) {
    await writeJsonAtomic(targetFile, profile);
  }
  return profile;
}

export async function bumpVisitCount(hostname: string): Promise<void> {
  const existing = await loadDomainProfile(hostname);
  const visitCount = (existing?.visitCount ?? 0) + 1;
  await saveDomainProfile(hostname, { visitCount });
}

export async function logMemorySuccess(
  hostname: string,
  intent: string,
  selector: string,
  fingerprint?: SelectorFingerprint,
  urlPath?: string
): Promise<void> {
  const profile = (await loadDomainProfile(hostname)) || {
    strategies: [],
    memories: [],
    failedSelectors: [],
    shadowDom: false,
    updatedAt: new Date().toISOString(),
    visitCount: 0,
  };

  let mem = profile.memories.find((m) => m.intent === intent && m.selector === selector);
  if (!mem) {
    mem = {
      intent,
      selector,
      urlPath,
      fingerprint,
      successCount: 0,
      failureCount: 0,
      consecutiveFailures: 0,
      lastSuccessVisit: profile.visitCount,
      state: "active",
    };
    profile.memories.push(mem);
  }

  mem.successCount++;
  mem.consecutiveFailures = 0;
  mem.lastSuccessVisit = profile.visitCount;
  if (fingerprint) {
    mem.fingerprint = { ...mem.fingerprint, ...fingerprint };
  }
  mem.state = "active";

  logDebug(`[Memory] Success logged for selector '${selector}' on intent '${intent}'.`);

  profile.failedSelectors = profile.failedSelectors.filter((f) => f.selector !== selector);

  await saveDomainProfile(hostname, {
    memories: profile.memories,
    failedSelectors: profile.failedSelectors,
  });
}

export async function logMemoryFailure(
  hostname: string,
  intent: string,
  selector: string,
  failureType: FailureType,
  urlPath?: string
): Promise<void> {
  const profile = (await loadDomainProfile(hostname)) || {
    strategies: [],
    memories: [],
    failedSelectors: [],
    shadowDom: false,
    updatedAt: new Date().toISOString(),
    visitCount: 0,
  };

  const mem = profile.memories.find((m) => m.intent === intent && m.selector === selector);
  if (mem) {
    mem.failureCount++;
    mem.consecutiveFailures++;
    logDebug(`[Memory] Failure logged for selector '${selector}'. Consecutive failures: ${mem.consecutiveFailures}`);
    if (mem.consecutiveFailures >= 5) {
      logDebug(`[Memory] Selector '${selector}' deprecated due to 5 consecutive failures.`);
      mem.state = "deprecated";
    }
  }

  const existingNeg = profile.failedSelectors.find((f) => f.selector === selector);
  if (existingNeg) {
    existingNeg.expiredAtVisit = profile.visitCount + 50;
    existingNeg.failureType = failureType;
  } else {
    profile.failedSelectors.push({
      selector,
      urlPath,
      failureType,
      expiredAtVisit: profile.visitCount + 50,
    });
  }

  await saveDomainProfile(hostname, {
    memories: profile.memories,
    failedSelectors: profile.failedSelectors,
  });
}

export interface MemoryHit {
  selector: string;
  fingerprint?: SelectorFingerprint;
  score: number;
}

export async function getBestSelectorForIntent(
  hostname: string,
  intent: string,
  urlPath?: string
): Promise<MemoryHit | undefined> {
  const profile = await loadDomainProfile(hostname);
  if (!profile) return undefined;

  let validMemories = profile.memories.filter(
    (m) => m.intent === intent && m.state !== "deprecated"
  );

  if (urlPath && validMemories.some((m) => m.urlPath === urlPath)) {
    validMemories = validMemories.filter((m) => m.urlPath === urlPath);
  } else if (urlPath) {
    const base = urlPath.split("/")[1];
    if (base) {
      const baseMatches = validMemories.filter((m) => m.urlPath && m.urlPath.startsWith(`/${base}`));
      if (baseMatches.length > 0) {
        validMemories = baseMatches;
      }
    }
  }

  if (validMemories.length === 0) return undefined;

  const scored = validMemories.map((mem) => {
    const totalAttempts = mem.successCount + mem.failureCount;
    const confidence = totalAttempts > 0 ? mem.successCount / totalAttempts : 0;
    const visitsSinceSuccess = Math.max(0, profile.visitCount - mem.lastSuccessVisit);
    const decayFactor = Math.max(0.1, 1 - visitsSinceSuccess * 0.05);
    const penalty = mem.consecutiveFailures * 0.2;
    const finalScore = confidence * decayFactor - penalty;

    logDebug(
      `[Memory] Evaluated intent '${intent}' on selector '${mem.selector}': Confidence=${confidence.toFixed(2)}, DecayFactor=${decayFactor.toFixed(2)}, Penalty=${penalty.toFixed(2)} => FinalScore=${finalScore.toFixed(2)}`
    );

    return { ...mem, score: finalScore };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  if (best.score > 0.5) {
    logDebug(`[Memory] Hit! High-confidence selector for '${intent}': ${best.selector} (Score: ${best.score.toFixed(2)})`);
    return { selector: best.selector, fingerprint: best.fingerprint, score: best.score };
  }

  logDebug(`[Memory] Miss. No selector met the 0.5 score threshold for intent '${intent}'.`);
  return undefined;
}

export async function detectFramework(session: CDP.Client): Promise<string | undefined> {
  try {
    const resp = await session.Runtime.evaluate({
      expression: `(function() {
        if (window.__NEXT_DATA__) return 'next';
        if (window.__NUXT__) return 'nuxt';
        if (window.___gatsby) return 'gatsby';
        if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || document.querySelector('[data-reactroot], [data-reactid]')) return 'react';
        const root = document.getElementById('root') || document.getElementById('app') || document.body?.firstElementChild;
        if (root && (root._reactRootContainer || Object.keys(root).some(k => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$')))) return 'react';
        if (window.__VUE__ || document.querySelector('[data-v-app]')) return 'vue';
        if (window.ng || document.querySelector('[ng-version]')) return 'angular';
        if (window.__svelte) return 'svelte';
        return undefined;
      })()`,
      returnByValue: true,
    });
    return typeof resp?.result?.value === "string" ? resp.result.value : undefined;
  } catch {
    return undefined;
  }
}

export async function detectShadowDom(session: CDP.Client): Promise<boolean> {
  try {
    const resp = await session.Runtime.evaluate({
      expression: `(function() {
        const els = document.querySelectorAll('*');
        for (let i = 0; i < els.length; i++) {
          if (els[i].shadowRoot) return true;
        }
        return false;
      })()`,
      returnByValue: true,
    });
    return !!resp?.result?.value;
  } catch {
    return false;
  }
}

export function formatDomainHint(hostname: string, profile: DomainProfile): string | undefined {
  const parts: string[] = [];
  if (profile.framework) parts.push(`framework: ${profile.framework}`);
  if (profile.shadowDom) parts.push("uses Shadow DOM");
  if (profile.strategies.length > 0) parts.push(`known strategies: ${profile.strategies.join(", ")}`);

  const activeMemories = profile.memories.filter((m) => m.state !== "deprecated").slice(0, 5);
  if (activeMemories.length > 0) {
    const inputs = activeMemories
      .map((k) => {
        const flag = k.state === "drift_detected" ? " [DRIFT_DETECTED: site may have changed]" : "";
        return `${k.intent} (${k.selector})${flag}`;
      })
      .join("; ");
    parts.push(`known intents: ${inputs}`);
  }
  if (parts.length === 0) return undefined;
  return `[Session Memory] ${hostname}: ${parts.join(" | ")}`;
}
