import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import CDP from "chrome-remote-interface";
import { GLOBAL_CONFIG_DIR } from "../config/loader.js";
import { logDebug } from "../audit/logger.js";
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
  expiredAtVisit: number; // The visit number when this negative memory can be retried
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

function domainFile(hostname: string): string {
  const safe = hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
  const memoryDir = join(GLOBAL_CONFIG_DIR, "memory");
  if (!fs.existsSync(memoryDir)) fs.mkdirSync(memoryDir, { recursive: true });
  return join(memoryDir, `${safe}.json`);
}

// memoryCache is capped at 200 DomainProfile entries (one per unique hostname).
// When the cap is hit, the oldest entry is evicted (insertion-order LRU) so the
// cache can't grow without bound over a long session.
const memoryCache = new Map<string, DomainProfile>();
const MEMORY_CACHE_MAX = 200;

function memoryCacheSet(hostname: string, profile: DomainProfile): void {
  if (memoryCache.size >= MEMORY_CACHE_MAX && !memoryCache.has(hostname)) {
    // Evict the oldest (first) entry
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

    // Auto-expire negative memory
    profile.failedSelectors = profile.failedSelectors.filter(
      (neg) => profile.visitCount < neg.expiredAtVisit
    );

    // Decay and drift detection
    for (const mem of profile.memories) {
      const visitsSinceSuccess = profile.visitCount - mem.lastSuccessVisit;

      if (mem.consecutiveFailures >= 3 && mem.successCount > 5) {
        mem.state = "drift_detected";
      } else if (visitsSinceSuccess > 20) {
        // Simple heuristic: if we visited the domain 20 times and didn't use this successfully, decay
        // For now just keep it active, confidence scoring will handle the numeric decay
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
  // NOTE: visitCount is NOT bumped here — call bumpVisitCount() only on page navigation.
  const visitCount = existing?.visitCount ?? 0;

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

  // Dedup strategies
  if (updates.strategies) {
    profile.strategies = Array.from(new Set([...(existing?.strategies || []), ...updates.strategies]));
  }

  memoryCacheSet(hostname, profile);

  // Gate profile writing on 3+ data points
  let dataPoints = profile.failedSelectors.length;
  for (const mem of profile.memories) {
    dataPoints += (mem.successCount + mem.failureCount);
  }

  if (dataPoints >= 3) {
    await writeFile(domainFile(hostname), JSON.stringify(profile, null, 2), "utf-8");
  }
  return profile;
}

/**
 * Increment the visit counter for a domain. Call this exactly once per page navigation,
 * NOT on every logMemorySuccess/Failure call.
 */
export async function bumpVisitCount(hostname: string): Promise<void> {
  const existing = await loadDomainProfile(hostname);
  const visitCount = (existing?.visitCount ?? 0) + 1;
  await saveDomainProfile(hostname, { visitCount } as any);
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

  let mem = profile.memories.find(m => m.intent === intent && m.selector === selector);
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
      state: "active"
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

  // If it was in failedSelectors, remove it
  profile.failedSelectors = profile.failedSelectors.filter(f => f.selector !== selector);

  await saveDomainProfile(hostname, {
    memories: profile.memories,
    failedSelectors: profile.failedSelectors
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

  const mem = profile.memories.find(m => m.intent === intent && m.selector === selector);
  if (mem) {
    mem.failureCount++;
    mem.consecutiveFailures++;
    logDebug(`[Memory] Failure logged for selector '${selector}'. Consecutive failures: ${mem.consecutiveFailures}`);
    if (mem.consecutiveFailures >= 5) {
      logDebug(`[Memory] Selector '${selector}' deprecated due to 5 consecutive failures.`);
      mem.state = "deprecated";
    }
  }

  // Add to negative memory, expires after 50 visits
  const existingNeg = profile.failedSelectors.find(f => f.selector === selector);
  if (existingNeg) {
    existingNeg.expiredAtVisit = profile.visitCount + 50;
    existingNeg.failureType = failureType;
  } else {
    profile.failedSelectors.push({
      selector,
      urlPath,
      failureType,
      expiredAtVisit: profile.visitCount + 50
    });
  }

  await saveDomainProfile(hostname, {
    memories: profile.memories,
    failedSelectors: profile.failedSelectors
  });
}

export interface MemoryHit {
  selector: string;
  fingerprint?: SelectorFingerprint;
  score: number;
}

/**
 * Evaluates memory entries and returns the highest confidence memory hit.
 */
export async function getBestSelectorForIntent(hostname: string, intent: string, urlPath?: string): Promise<MemoryHit | undefined> {
  const profile = await loadDomainProfile(hostname);
  if (!profile) return undefined;

  let validMemories = profile.memories.filter(
    m => m.intent === intent && m.state !== "deprecated"
  );

  if (urlPath && validMemories.some(m => m.urlPath === urlPath)) {
    // Exact path match takes precedence
    validMemories = validMemories.filter(m => m.urlPath === urlPath);
  } else if (urlPath) {
    // If no exact match, try broad match (e.g. same base path) or fallback to global
    const base = urlPath.split('/')[1];
    const baseMatches = validMemories.filter(m => m.urlPath && m.urlPath.startsWith(`/${base}`));
    if (baseMatches.length > 0) {
      validMemories = baseMatches;
    }
  }

  if (validMemories.length === 0) return undefined;

  // Score = successRate * decayFactor - penalty
  const scored = validMemories.map(mem => {
    const totalAttempts = mem.successCount + mem.failureCount;
    const confidence = totalAttempts > 0 ? mem.successCount / totalAttempts : 0;
    const visitsSinceSuccess = Math.max(0, profile.visitCount - mem.lastSuccessVisit);

    // Decay factor (staleness): drops 5% per visit without success, floor at 0.1
    const decayFactor = Math.max(0.1, 1 - (visitsSinceSuccess * 0.05));

    // Penalty for recent consecutive failures (reliability cliff)
    const penalty = mem.consecutiveFailures * 0.2;

    const finalScore = (confidence * decayFactor) - penalty;

    logDebug(`[Memory] Evaluated intent '${intent}' on selector '${mem.selector}': Confidence=${confidence.toFixed(2)}, DecayFactor=${decayFactor.toFixed(2)}, Penalty=${penalty.toFixed(2)} => FinalScore=${finalScore.toFixed(2)}`);

    return { ...mem, score: finalScore };
  });

  scored.sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (best.score > 0.5) {
    logDebug(`[Memory] Hit! Skipping LLM. High-confidence selector for '${intent}': ${best.selector} (Score: ${best.score.toFixed(2)})`);
    return { selector: best.selector, fingerprint: best.fingerprint, score: best.score };
  }

  logDebug(`[Memory] Miss. No selector met the 0.5 score threshold for intent '${intent}'. Falling back to DOM heuristic / LLM.`);
  return undefined;
}

/**
 * Detect the frontend framework used by the current page.
 */
export async function detectFramework(session: CDP.Client): Promise<string | undefined> {
  const checks = [
    { expr: `!!window.__REACT_DEVTOOLS_GLOBAL_HOOK__ && !!document.querySelector('[data-reactroot], [data-reactid]')`, name: 'react' },
    { expr: `!!window.__VUE__ || !!document.querySelector('[data-v-]')`, name: 'vue' },
    { expr: `!!window.angular || !!document.querySelector('[ng-]')`, name: 'angular' },
    { expr: `!!window.LitElement || !!document.querySelector('[lit-element]')`, name: 'lit' },
    { expr: `!!window.SvelteComponent || !!document.querySelector('[svelte]')`, name: 'svelte' },
    { expr: `!!window.NextRouter`, name: 'next' },
    { expr: `!!window.__NUXT__`, name: 'nuxt' },
    { expr: `!!window.Gatsby`, name: 'gatsby' },
  ];
  for (const check of checks) {
    try {
      const resp = await session.Runtime.evaluate({
        expression: `(function() { return ${check.expr}; })()`,
        returnByValue: true,
      });
      if (resp?.result?.value) return check.name;
    } catch { /* ignore */ }
  }
  return undefined;
}

/**
 * Check if the page uses Shadow DOM.
 */
export async function detectShadowDom(session: CDP.Client): Promise<boolean> {
  try {
    const resp = await session.Runtime.evaluate({
      expression: `(function() {
        return document.querySelectorAll('*').some(el => el.shadowRoot !== null);
      })()`,
      returnByValue: true,
    });
    return !!resp?.result?.value;
  } catch {
    return false;
  }
}

/**
 * Format a domain profile as a system hint string.
 */
export function formatDomainHint(hostname: string, profile: DomainProfile): string | undefined {
  const parts: string[] = [];
  if (profile.framework) parts.push(`framework: ${profile.framework}`);
  if (profile.shadowDom) parts.push('uses Shadow DOM');
  if (profile.strategies.length > 0) parts.push(`known strategies: ${profile.strategies.join(', ')}`);

  const activeMemories = profile.memories.filter(m => m.state !== "deprecated");
  if (activeMemories.length > 0) {
    const inputs = activeMemories.map(k => {
      let flag = '';
      if (k.state === 'drift_detected') flag = ' [DRIFT_DETECTED: site may have changed]';
      return `${k.intent} (${k.selector})${flag}`;
    }).join('; ');
    parts.push(`known intents: ${inputs}`);
  }
  if (parts.length === 0) return undefined;
  return `[Session Memory] ${hostname}: ${parts.join(' | ')}`;
}
