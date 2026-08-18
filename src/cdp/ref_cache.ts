/**
 * Weavetab — cdp/ref_cache.ts
 * Unified Ref Coordinate Cache (URC)
 *
 * Single in-memory, per-tab store of refId → {selector, x, y, backendNodeId, fingerprint}
 * populated once by buildActionMap/buildAXTreeMap and read by every interaction tool.
 *
 * Design goals:
 * - Zero extra CDP calls on cache hit (< TTL)
 * - One atomic Runtime.evaluate on stale/miss (atomicResolve)
 * - Keyed strictly by targetId (frame-scoped) — iframe contexts never bleed
 * - Auto-invalidated on frameNavigated
 *
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RefCoordEntry {
  /** Primary selector — [data-wt-id="..."] form preferred */
  selector: string;
  /** Center X at capture time */
  x: number;
  /** Center Y at capture time */
  y: number;
  /** Epoch ms — for TTL gate */
  capturedAt: number;
  /** CDP backendNodeId for re-resolution via DOM.getBoxModel when selector fails */
  backendNodeId?: number;
  /**
   * Lightweight identity string: "tag:role:labelPrefix"
   * Checked inside atomicResolve to detect DOM replacement (re-render).
   */
  fingerprint: string;
  /** Holographic: visual bounding box hash for deduplication */
  visualHash?: string;
  /** Holographic: full or partial XPath */
  xpath?: string;
  /** Holographic: current value for stateful tracking */
  value?: string;
  /** Holographic: label text */
  label?: string;
}

export interface AtomicResolveResult {
  status: "OK" | "NOT_FOUND" | "STALE" | "INVISIBLE" | "SHADOW";
  x?: number;
  y?: number;
}

// ─── Storage ──────────────────────────────────────────────────────────────────

/** Per-tab: Map<targetId, Map<refId, RefCoordEntry>> */
const store = new Map<string, Map<string, RefCoordEntry>>();

/** Default TTL: 30 seconds. Overridden by config.refCacheTtlMs at call sites. */
export const DEFAULT_URC_TTL_MS = 30_000;

// ─── Stale-miss counters (foundation for adaptive TTL — Q3 follow-up) ─────────

const staleMissCounters = new Map<string, { count: number; lastDecayAt: number }>();

function recordStaleMiss(hostname: string): void {
  const now = Date.now();
  const entry = staleMissCounters.get(hostname) ?? { count: 0, lastDecayAt: now };
  // Decay: halve the counter every 5 minutes
  const decayIntervals = Math.floor((now - entry.lastDecayAt) / (5 * 60_000));
  if (decayIntervals > 0) {
    entry.count = Math.floor(entry.count / Math.pow(2, decayIntervals));
    entry.lastDecayAt = now;
  }
  entry.count += 1;
  staleMissCounters.set(hostname, entry);
}

// Sweep staleMissCounters entries that have decayed to 0 so hostnames don't
// accumulate indefinitely. Runs every 10 minutes via an unref'd interval.
setInterval(() => {
  const now = Date.now();
  for (const [hostname, entry] of staleMissCounters.entries()) {
    const decayIntervals = Math.floor((now - entry.lastDecayAt) / (5 * 60_000));
    const decayed = decayIntervals > 0
      ? Math.floor(entry.count / Math.pow(2, decayIntervals))
      : entry.count;
    if (decayed <= 0) staleMissCounters.delete(hostname);
  }
}, 10 * 60_000).unref();

/** Returns stale miss rate [0–1] for the last observation window. */
export function getStaleMissRate(hostname: string): number {
  const entry = staleMissCounters.get(hostname);
  if (!entry) return 0;
  // Simple heuristic: count > 5 within the window → elevated stale rate
  return Math.min(1, entry.count / 20);
}


// ─── Public API ───────────────────────────────────────────────────────────────

/** Write an entry into the URC for a given tab and refId. */
export function urcSet(targetId: string, refId: string, entry: RefCoordEntry): void {
  if (!store.has(targetId)) store.set(targetId, new Map());
  store.get(targetId)!.set(refId, entry);
}

/**
 * Read an entry from the URC.
 * Returns null if: not found, OR entry is older than maxAgeMs.
 */
export function urcGet(
  targetId: string,
  refId: string,
  maxAgeMs = DEFAULT_URC_TTL_MS,
): RefCoordEntry | null {
  const tabMap = store.get(targetId);
  if (!tabMap) return null;
  const entry = tabMap.get(refId);
  if (!entry) return null;
  if (Date.now() - entry.capturedAt > maxAgeMs) return null;
  return entry;
}

/** Return all cached entries for a tab (used by health checks and delta validation). */
export function urcGetAll(targetId: string): Map<string, RefCoordEntry> {
  return store.get(targetId) ?? new Map();
}

/**
 * Invalidate all URC entries for a tab.
 * Must be called on: frameNavigated, full map rebuild, tab close.
 */
export function urcInvalidate(targetId: string): void {
  store.delete(targetId);
}

/**
 * Bulk-populate the URC from a freshly built ActionElement array.
 * Called at the end of buildActionMap and buildAXTreeMap.
 * Only writes entries that have both x and selector defined.
 */
export function urcPopulate(
  targetId: string,
  elements: Array<{
    id: string;
    selector?: string;
    x?: number;
    y?: number;
    backendNodeId?: number;
    role?: string;
    label?: string;
    value?: string;
    type?: string;
    fingerprint?: string;
    visualHash?: string;
    xpath?: string;
  }>,
): void {
  const now = Date.now();
  for (const el of elements) {
    if (!el.selector || el.x === undefined || el.y === undefined) continue;
    const fingerprint =
      el.fingerprint ??
      `${el.role ?? ""}:${el.type ?? ""}:${(el.label ?? "").slice(0, 30)}`;
    urcSet(targetId, el.id, {
      selector: el.selector,
      x: el.x,
      y: el.y,
      capturedAt: now,
      backendNodeId: el.backendNodeId,
      fingerprint,
      visualHash: el.visualHash,
      xpath: el.xpath,
      value: el.value,
      label: el.label,
    });
  }
}

// ─── Atomic Resolution ────────────────────────────────────────────────────────

/**
 * Single CDP Runtime.evaluate that simultaneously:
 *  1. Finds the element via selector (with WeakMap re-hydration fallback)
 *  2. Validates tag/role fingerprint (lightweight string check)
 *  3. Returns fresh coordinates from getBoundingClientRect
 *
 * Cost: 1 CDP call (~2–5ms). On a URC cache hit this is the ONLY extra call made.
 * On a full miss (Stage 3+) it is still cheaper than re-running buildActionMap.
 */
export async function atomicResolve(
  session: CDP.Client,
  selector: string,
  fingerprint?: string,
  hostname?: string,
): Promise<AtomicResolveResult> {
  try {
    const { result } = await session.Runtime.evaluate({
      expression: `(function(sel, fp) {
        try {
          // Primary: standard querySelector
          var el = document.querySelector(sel);

          // Shadow DOM fallback
          if (!el && typeof window.__Weavetab_shadowQuery === 'function') {
            el = window.__Weavetab_shadowQuery(sel);
          }

          // WeakMap registry fallback: re-derive selector from stored data
          if (!el && window.__wt_registry) {
            // Walk the registry to find the element whose stored id matches
            // (only feasible for small pages — skip for large DOMs by checking size)
            try {
              var allEls = document.querySelectorAll('[data-wt-id]');
              for (var i = 0; i < allEls.length; i++) {
                var candidate = allEls[i];
                var entry = window.__wt_registry.get(candidate);
                if (entry && ('[data-wt-id="' + entry.id + '"]' === sel ||
                    entry.selector === sel)) {
                  el = candidate;
                  break;
                }
              }
            } catch (e) {}
          }

          if (!el) return { status: 'NOT_FOUND' };

          // Fingerprint check: "role:type:labelPrefix"
          if (fp) {
            var parts = fp.split(':');
            var fpRole = parts[0];
            var fpType = parts[1];
            var elRole = el.getAttribute('role') || el.tagName.toLowerCase();
            var elType = (el.type || '').toLowerCase();
            if (fpRole && fpRole !== '' && elRole !== fpRole && elType !== fpRole) {
              return { status: 'STALE' };
            }
          }

          var rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) return { status: 'INVISIBLE' };

          // Scroll into view if out of viewport
          if (rect.top < 0 || rect.bottom > window.innerHeight ||
              rect.left < 0 || rect.right > window.innerWidth) {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            rect = el.getBoundingClientRect();
          }

          // Re-hydrate data-wt-id attribute if stripped by SPA reconciliation
          var idMatch = sel.match(/\\[data-wt-id="([^"]+)"\\]/);
          if (idMatch && !el.hasAttribute('data-wt-id')) {
            try { el.setAttribute('data-wt-id', idMatch[1]); } catch(e) {}
          }

          return {
            status: 'OK',
            x: Math.round(rect.left + rect.width / 2),
            y: Math.round(rect.top + rect.height / 2)
          };
        } catch (e) {
          return { status: 'NOT_FOUND' };
        }
      })(${JSON.stringify(selector)}, ${JSON.stringify(fingerprint ?? null)})`,
      returnByValue: true,
      awaitPromise: false,
    });

    const val = result?.value as AtomicResolveResult | undefined;
    if (!val) return { status: "NOT_FOUND" };

    // Track stale misses for adaptive TTL follow-up
    if (val.status === "STALE" && hostname) {
      recordStaleMiss(hostname);
    }

    return val;
  } catch {
    return { status: "NOT_FOUND" };
  }
}

/**
 * Attempt coordinate resolution via CDP DOM.getBoxModel using a backendNodeId.
 * Used as Stage 4 in the click fallback chain when the selector path is unavailable.
 */
export async function resolveViaBackendNodeId(
  session: CDP.Client,
  backendNodeId: number,
): Promise<{ x: number; y: number } | null> {
  try {
    const { nodeIds } = await session.DOM.pushNodesByBackendIdsToFrontend({
      backendNodeIds: [backendNodeId],
    });
    if (!nodeIds?.[0]) return null;
    const { model } = await session.DOM.getBoxModel({ nodeId: nodeIds[0] });
    if (!model?.content) return null;
    const c = model.content;
    return {
      x: Math.round((c[0]! + c[4]!) / 2),
      y: Math.round((c[1]! + c[5]!) / 2),
    };
  } catch {
    return null;
  }
}
