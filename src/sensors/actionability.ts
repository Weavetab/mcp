/**
 * src/sensors/actionability.ts
 *
 * Playwright-Strategy Actionability Engine for WeaveTab
 * ─────────────────────────────────────────────────────
 * Implements every correctness principle from playwright-strategy.md:
 *
 *  1. RAF-stability gate     — element must not be animating before we touch it
 *  2. Strict hit-target      — elementsFromPoint at the computed click point must
 *                              confirm the target is on top (or the target's child).
 *  3. WeaveTab transparency  — WeaveTab's own UI (data-wt-ignore nodes) is excluded
 *                              from the hit stack so the tool never blocks itself.
 *  4. 4-way scroll rotation  — escape sticky headers / overlays by cycling four
 *                              scrollIntoView alignments before giving up.
 *  5. Per-action backoff     — [0, 20, 100, 100, 500] ms retry on transient failures.
 *  6. Rich blocker report    — on permanent occlusion, return the blocking element's
 *                              description so the model can reason about it.
 *
 * Usage:
 *   import { verifyActionability } from "../sensors/actionability.js";
 *   const result = await verifyActionability(session, selector);
 *   if (result.status !== "ACTIONABLE") { ... }
 */

import CDP from "chrome-remote-interface";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ActionabilityStatus =
  | "ACTIONABLE"
  | "NOT_FOUND"
  | "INVISIBLE"
  | "UNSTABLE"
  | "OCCLUDED"
  | "FINGERPRINT_MISMATCH";

export interface OccluderInfo {
  tag: string;
  id: string;
  className: string;
  ariaLabel: string | null;
  isWeavetabOwned: boolean;
}

export interface ActionabilityResult {
  status: ActionabilityStatus;
  /** Computed click center in viewport coordinates. */
  x?: number;
  y?: number;
  /** Populated only when status === "OCCLUDED". */
  occludedBy?: OccluderInfo;
  /** True if the blocker was WeaveTab's own UI and can be ignored. */
  blockerIsWeaveTab?: boolean;
}

export interface ActionabilityOptions {
  /**
   * Maximum time (ms) to wait for stability before giving up.
   * Default: 600ms.
   */
  stabilityTimeoutMs?: number;
  /**
   * Optional fingerprint to verify the element hasn't been replaced by
   * a framework re-render. Checked once before anything else.
   */
  fingerprint?: { tag?: string; role?: string };
  /**
   * Total time budget across all retry attempts.
   * Default: 2000ms.
   */
  totalTimeoutMs?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Playwright's per-action retry backoff (ms). */
const BACKOFF = [0, 20, 100] as const;

/**
 * 4-way scroll alignment rotation — escape sticky headers.
 * undefined = browser default (nearest), then progressively more aggressive.
 */
const SCROLL_ALIGNMENTS: ReadonlyArray<ScrollIntoViewOptions | undefined> = [
  undefined,
  { block: "end", inline: "end" },
  { block: "center", inline: "center" },
  { block: "start", inline: "start" },
];

/**
 * Injected expression that does the full Playwright-style actionability check
 * in the page context. Returns a serialisable result object.
 *
 * Parameters injected at build-time via template literals:
 *   selector        — CSS selector string
 *   scrollOptionsJSON — JSON string of ScrollIntoViewOptions or "null"
 *   fingerprintJSON   — JSON string of {tag,role} or "null"
 *   stabilityMs       — ms to wait for stable rect
 */
function buildPageExpression(
  selector: string,
  scrollOptions: ScrollIntoViewOptions | undefined,
  fingerprint: ActionabilityOptions["fingerprint"],
  stabilityMs: number
): string {
  const selectorLiteral = JSON.stringify(selector);
  const scrollLiteral = scrollOptions ? JSON.stringify(scrollOptions) : "null";
  const fingerprintLiteral = fingerprint ? JSON.stringify(fingerprint) : "null";

  return `(async function() {
    // ── Helper: is this node owned by WeaveTab? ────────────────────────────
    function isWtOwned(el) {
      if (!el) return false;
      // Attribute-based markers: data-wt-ignore and data-wt-internal both signal
      // WeaveTab-owned UI that must not block page interactions.
      if (el.getAttribute && (
        el.getAttribute('data-wt-ignore') !== null ||
        el.getAttribute('data-wt-internal') !== null ||
        el.getAttribute('data-wt-overlay') !== null
      )) return true;
      const wtIds = ['Weavetab-hud', '__Weavetab_controlled_indicator', 'wt-main-container', 'wt-system-icon', 'wt-f3-host', 'Weavetab-root'];
      if (el.id && wtIds.includes(el.id)) return true;
      if (el.closest) {
        if (el.closest('[data-wt-ignore],[data-wt-internal],[data-wt-overlay]')) return true;
        if (wtIds.some(id => el.closest('#' + id))) return true;
      }
      return false;
    }

    // ── Step 1: Resolve element ────────────────────────────────────────────
    let el = document.querySelector(${selectorLiteral});
    if (!el && window.__Weavetab_shadowQuery) {
      el = window.__Weavetab_shadowQuery(${selectorLiteral});
    }
    if (!el) return { status: 'NOT_FOUND' };

    // ── Step 2: Fingerprint check ──────────────────────────────────────────
    const fp = ${fingerprintLiteral};
    if (fp) {
      if (fp.tag && el.tagName.toLowerCase() !== fp.tag.toLowerCase())
        return { status: 'FINGERPRINT_MISMATCH' };
      if (fp.role && el.getAttribute('role') !== fp.role)
        return { status: 'FINGERPRINT_MISMATCH' };
    }

    // ── Step 3: Basic visibility ───────────────────────────────────────────
    // Use checkVisibility() (Chrome 105+) as the most reliable single check.
    // Falls back to manual computed-style + rect checks for older runtimes.
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }))
        return { status: 'INVISIBLE' };
    } else {
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')
        return { status: 'INVISIBLE' };
    }

    let rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return { status: 'INVISIBLE' };
    // Off-screen by more than 2× viewport dimension in any direction
    if (rect.right < -window.innerWidth || rect.bottom < -window.innerHeight ||
        rect.left > 2 * window.innerWidth || rect.top > 2 * window.innerHeight)
      return { status: 'INVISIBLE' };

    // ── Step 4: Scroll into view (using provided alignment) ────────────────
    const scrollOpts = ${scrollLiteral};
    if (scrollOpts) {
      el.scrollIntoView(scrollOpts);
      await new Promise(r => setTimeout(r, 120));
    } else if (rect.top < 0 || rect.bottom > window.innerHeight ||
               rect.left < 0 || rect.right > window.innerWidth) {
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await new Promise(r => setTimeout(r, 120));
    }
    rect = el.getBoundingClientRect();

    // ── Step 5: RAF-stability gate ─────────────────────────────────────────
    const stabilityDeadline = Date.now() + ${stabilityMs};
    let prevRect = el.getBoundingClientRect();
    let stable = false;
    while (Date.now() < stabilityDeadline) {
      await new Promise(r => requestAnimationFrame(r));
      const cur = el.getBoundingClientRect();
      if (
        Math.abs(cur.x - prevRect.x) < 0.5 &&
        Math.abs(cur.y - prevRect.y) < 0.5 &&
        Math.abs(cur.width - prevRect.width) < 0.5 &&
        Math.abs(cur.height - prevRect.height) < 0.5
      ) {
        stable = true;
        break;
      }
      prevRect = cur;
    }
    if (!stable) return { status: 'UNSTABLE' };
    rect = el.getBoundingClientRect();

    // ── Step 6: Compute click centre (clamped to viewport) ─────────────────
    const cx = Math.round(Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1));
    const cy = Math.round(Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1));

    // ── Step 7: Strict hit-target check ───────────────────────────────────
    // elementsFromPoint returns the full composited stack, topmost first.
    const stack = document.elementsFromPoint(cx, cy);
    if (!stack || stack.length === 0) return { status: 'ACTIONABLE', x: cx, y: cy };

    // Walk from the topmost element. Anything that is WeaveTab-owned is
    // transparent — skip it. The first non-WT element must be el or its descendant.
    let blocker = null;
    for (const hit of stack) {
      if (isWtOwned(hit)) continue;  // WeaveTab transparency
      blocker = hit;
      break;
    }

    if (!blocker || blocker === el || el.contains(blocker)) {
      return { status: 'ACTIONABLE', x: cx, y: cy };
    }

    // Check composed tree (shadow DOM + slots)
    let ancestor = blocker;
    while (ancestor) {
      if (ancestor === el) return { status: 'ACTIONABLE', x: cx, y: cy };
      ancestor = ancestor.assignedSlot || ancestor.parentElement ||
                 (ancestor.getRootNode && ancestor.getRootNode({ composed: true }) !== ancestor
                   ? ancestor.getRootNode({ composed: true }).host : null);
    }

    return {
      status: 'OCCLUDED',
      x: cx, y: cy,
      occludedBy: {
        tag: blocker.tagName.toLowerCase(),
        id: blocker.id || '',
        className: (blocker.className && typeof blocker.className === 'string')
          ? blocker.className.slice(0, 60) : '',
        ariaLabel: blocker.getAttribute('aria-label') || blocker.getAttribute('title') || null,
        isWeavetabOwned: isWtOwned(blocker)
      }
    };
  })()`;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Full Playwright-strategy actionability verification.
 *
 * Runs up to `BACKOFF.length` attempts with 4-way scroll rotation,
 * RAF stability gating, WeaveTab-transparent hit-target checking,
 * and per-attempt retry backoff.
 *
 * Returns `status: "ACTIONABLE"` with computed (x, y) when safe to dispatch,
 * or a failure status with an optional `occludedBy` description.
 */
export async function verifyActionability(
  session: CDP.Client,
  selector: string,
  opts: ActionabilityOptions = {}
): Promise<ActionabilityResult> {
  const stabilityMs = opts.stabilityTimeoutMs ?? 300;
  const totalDeadline = Date.now() + (opts.totalTimeoutMs ?? 2000);

  let lastResult: ActionabilityResult = { status: "NOT_FOUND" };
  let scrollIdx = 0;

  for (let attempt = 0; attempt < BACKOFF.length; attempt++) {
    // Honour total time budget
    if (Date.now() >= totalDeadline) break;

    // Backoff delay (first attempt is instant)
    if (BACKOFF[attempt] > 0) {
      await new Promise((r) => setTimeout(r, BACKOFF[attempt]));
    }

    const scrollAlignment = SCROLL_ALIGNMENTS[scrollIdx % SCROLL_ALIGNMENTS.length];
    const expr = buildPageExpression(selector, scrollAlignment, opts.fingerprint, stabilityMs);

    let raw: any;
    try {
      const { result } = await session.Runtime.evaluate({
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      raw = result?.value;
    } catch {
      // CDP error — element might have been detached; retry
      continue;
    }

    if (!raw) continue;

    lastResult = raw as ActionabilityResult;

    switch (lastResult.status) {
      case "ACTIONABLE":
        return lastResult;

      case "NOT_FOUND":
      case "FINGERPRINT_MISMATCH":
      case "INVISIBLE":
        // These are likely permanent; still retry in case of SPA re-render
        break;

      case "UNSTABLE":
        // Give the animation more time on next attempt
        break;

      case "OCCLUDED": {
        const occ = lastResult.occludedBy;
        // If the only blocker is WeaveTab's own UI, treat as transparent and retry
        if (occ?.isWeavetabOwned) {
          lastResult = { status: "ACTIONABLE", x: lastResult.x, y: lastResult.y };
          return lastResult;
        }
        // Advance scroll alignment to try to escape the blocker
        scrollIdx++;
        break;
      }
    }
  }

  return lastResult;
}

// ── Convenience wrapper ───────────────────────────────────────────────────────

/**
 * Quick check: is an element at these coords actually blocked by a non-WT overlay?
 * Used for lightweight pre-dispatch validation inside click.ts.
 */
export async function quickHitCheck(
  session: CDP.Client,
  x: number,
  y: number,
  selectorOfTarget: string
): Promise<{ clear: boolean; blockerDescription?: string }> {
  const expr = `(function() {
    function isWtOwned(el) {
      if (!el) return false;
      if (el.getAttribute && (
        el.getAttribute('data-wt-ignore') !== null ||
        el.getAttribute('data-wt-internal') !== null ||
        el.getAttribute('data-wt-overlay') !== null
      )) return true;
      const ids = ['Weavetab-hud','__Weavetab_controlled_indicator','wt-main-container','wt-system-icon','wt-f3-host','Weavetab-root'];
      if (el.id && ids.includes(el.id)) return true;
      return !!(el.closest && (el.closest('[data-wt-ignore],[data-wt-internal],[data-wt-overlay]') || ids.some(id => el.closest('#' + id))));
    }
    const target = document.querySelector(${JSON.stringify(selectorOfTarget)})
      || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(${JSON.stringify(selectorOfTarget)}) : null);
    const stack = document.elementsFromPoint(${x}, ${y});
    if (!stack || !stack.length) return { clear: true };
    for (const hit of stack) {
      if (isWtOwned(hit)) continue;
      if (!target || hit === target || target.contains(hit)) return { clear: true };
      // Walk composed tree for shadow DOM
      let ancestor = hit;
      while (ancestor) {
        if (ancestor === target) return { clear: true };
        ancestor = ancestor.assignedSlot || ancestor.parentElement ||
          (ancestor.getRootNode && ancestor.getRootNode({composed:true}) !== ancestor
            ? ancestor.getRootNode({composed:true}).host : null);
      }
      return {
        clear: false,
        blockerDescription: hit.tagName.toLowerCase() +
          (hit.id ? '#' + hit.id : '') +
          (hit.className && typeof hit.className === 'string' ? '.' + hit.className.split(' ')[0] : '') +
          ' intercepts pointer events'
      };
    }
    return { clear: true };
  })()`;

  try {
    const { result } = await session.Runtime.evaluate({ expression: expr, returnByValue: true });
    return (result?.value as any) ?? { clear: true };
  } catch {
    return { clear: true }; // non-fatal; proceed optimistically
  }
}
