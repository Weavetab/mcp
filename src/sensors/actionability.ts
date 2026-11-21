import CDP from "chrome-remote-interface";

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
  x?: number;
  y?: number;
  occludedBy?: OccluderInfo;
  blockerIsWeaveTab?: boolean;
}

export interface ActionabilityOptions {
  stabilityTimeoutMs?: number;
  fingerprint?: { tag?: string; role?: string };
  totalTimeoutMs?: number;
}

const BACKOFF = [0, 20, 100, 250] as const;

const SCROLL_ALIGNMENTS: ReadonlyArray<ScrollIntoViewOptions | undefined> = [
  undefined,
  { block: "end", inline: "end" },
  { block: "center", inline: "center" },
  { block: "start", inline: "start" },
];

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
    function isWtOwned(el) {
      if (!el) return false;
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

    let el = null;
    try {
      el = document.querySelector(${selectorLiteral});
      if (!el && window.__Weavetab_shadowQuery) {
        el = window.__Weavetab_shadowQuery(${selectorLiteral});
      }
    } catch (e) {
      return { status: 'NOT_FOUND', invalidSelector: true };
    }
    if (!el) return { status: 'NOT_FOUND' };

    const fp = ${fingerprintLiteral};
    if (fp) {
      if (fp.tag && el.tagName.toLowerCase() !== fp.tag.toLowerCase())
        return { status: 'FINGERPRINT_MISMATCH' };
      if (fp.role && el.getAttribute('role') !== fp.role)
        return { status: 'FINGERPRINT_MISMATCH' };
    }

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

    if (rect.right < -window.innerWidth || rect.bottom < -window.innerHeight ||
        rect.left > 2 * window.innerWidth || rect.top > 2 * window.innerHeight)
      return { status: 'INVISIBLE' };

    const stabilityDeadline = Date.now() + ${stabilityMs};
    let prevRect = el.getBoundingClientRect();
    let stable = false;
    while (Date.now() < stabilityDeadline) {
      await new Promise(r => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; r(null); } };
        requestAnimationFrame(done);
        setTimeout(done, 50);
      });
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

    const cx = Math.round(Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1));
    const cy = Math.round(Math.min(Math.max(rect.top + rect.height / 2, 0), window.innerHeight - 1));

    const stack = document.elementsFromPoint(cx, cy);
    if (!stack || stack.length === 0) return { status: 'ACTIONABLE', x: cx, y: cy };

    let blocker = null;
    for (const hit of stack) {
      if (isWtOwned(hit)) continue;
      blocker = hit;
      break;
    }

    if (!blocker || blocker === el || el.contains(blocker)) {
      return { status: 'ACTIONABLE', x: cx, y: cy };
    }

    let ancestor = blocker;
    while (ancestor) {
      if (ancestor === el) return { status: 'ACTIONABLE', x: cx, y: cy };
      let next = ancestor.assignedSlot || ancestor.parentElement;
      if (!next && ancestor.getRootNode) {
        const r = ancestor.getRootNode();
        next = (r && r.host) ? r.host : null;
      }
      ancestor = next;
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

export async function verifyActionability(
  session: CDP.Client,
  selector: string,
  opts: ActionabilityOptions = {}
): Promise<ActionabilityResult> {
  const stabilityMs = opts.stabilityTimeoutMs ?? 300;
  const totalTimeoutMs = opts.totalTimeoutMs ?? 2000;
  const totalDeadline = Date.now() + totalTimeoutMs;

  let lastResult: ActionabilityResult = { status: "NOT_FOUND" };
  let scrollIdx = 0;

  for (let attempt = 0; attempt < BACKOFF.length; attempt++) {
    if (Date.now() >= totalDeadline) break;

    if (BACKOFF[attempt]! > 0) {
      await new Promise((r) => setTimeout(r, BACKOFF[attempt]));
    }

    const remainingMs = Math.max(200, totalDeadline - Date.now());
    const evalTimeout = Math.min(remainingMs, stabilityMs + 600);
    const scrollAlignment = SCROLL_ALIGNMENTS[scrollIdx % SCROLL_ALIGNMENTS.length];
    const expr = buildPageExpression(selector, scrollAlignment, opts.fingerprint, stabilityMs);

    let raw: any;
    try {
      const { result } = await (session.Runtime.evaluate as any)({
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        timeout: evalTimeout,
      });
      raw = result?.value;
    } catch {
      continue;
    }

    if (!raw) continue;

    if (raw.invalidSelector) {
      return { status: "NOT_FOUND" };
    }

    lastResult = raw as ActionabilityResult;

    switch (lastResult.status) {
      case "ACTIONABLE":
        return lastResult;

      case "NOT_FOUND":
      case "FINGERPRINT_MISMATCH":
      case "INVISIBLE":
      case "UNSTABLE":
        break;

      case "OCCLUDED": {
        const occ = lastResult.occludedBy;
        if (occ?.isWeavetabOwned) {
          lastResult = { status: "ACTIONABLE", x: lastResult.x, y: lastResult.y };
          return lastResult;
        }
        scrollIdx++;
        break;
      }
    }
  }

  return lastResult;
}

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
    let target = null;
    try {
      target = document.querySelector(${JSON.stringify(selectorOfTarget)})
        || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(${JSON.stringify(selectorOfTarget)}) : null);
    } catch (e) {
      return { clear: false, blockerDescription: 'Invalid CSS selector' };
    }
    const stack = document.elementsFromPoint(${x}, ${y});
    if (!stack || !stack.length) return { clear: true };
    for (const hit of stack) {
      if (isWtOwned(hit)) continue;
      if (!target || hit === target || target.contains(hit)) return { clear: true };
      let ancestor = hit;
      while (ancestor) {
        if (ancestor === target) return { clear: true };
        let next = ancestor.assignedSlot || ancestor.parentElement;
        if (!next && ancestor.getRootNode) {
          const r = ancestor.getRootNode();
          next = (r && r.host) ? r.host : null;
        }
        ancestor = next;
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
    return { clear: true };
  }
}
