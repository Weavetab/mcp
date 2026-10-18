/**
 * Weavetab — tools/scroll.ts
 * Scrolls the page or a specific element in any direction.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import { buildActionMap, findBestMatch, safeSelector } from "../cdp/walker.js";
import { getCachedActionMap, cacheActionMap } from "../state/cache.js";
import { computeDelta, storeSnapshot } from "../state/delta.js";
import { waitForDOMStable } from "../sensors/guard.js";
import { sessionRegistry } from "../state/session.js";
import { logAction } from "../audit/logger.js";

import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";
import type { WeaveError } from "./click.js";
import { sendToExtension } from "../cdp/helpers.js";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export interface ScrollResult {
  success: true;
  scrolled: string;
  direction: string;
  distance: number;
  new_visible_count?: number;
  dom_changed: boolean;
}

// Track scroll frequency
let recentScrolls: number[] = [];

// helper for realistic human timing
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomBetween = (min: number, max: number) => Math.random() * (max - min) + min;

function applyEasing(t: number, type: string): number {
  switch (type) {
    case 'quarticOut': return 1 - Math.pow(1 - t, 4);
    case 'cubicOut': return 1 - Math.pow(1 - t, 3);
    case 'linear': return t;
    default: return t;
  }
}

export async function browserScroll(
  session: CDP.Client,
  args: {
    id?: string;
    label?: string;
    direction: "up" | "down" | "left" | "right";
    distance?: number;
    pixels?: number;
    amount?: number;
    speed?: "human" | "read" | "fast";
  },
  config: Config
): Promise<ScrollResult | WeaveError> {
  let { id, label, direction, speed = "human" } = args;
  let distance = args.distance ?? args.pixels ?? args.amount ?? 400;

  if (distance < 0) {
    distance = Math.abs(distance);
    if (direction === "down") direction = "up";
    else if (direction === "up") direction = "down";
    else if (direction === "left") direction = "right";
    else if (direction === "right") direction = "left";
  }
  
  const now = Date.now();
  recentScrolls = recentScrolls.filter(t => now - t < 5000);
  recentScrolls.push(now);
  if (recentScrolls.length > 3) {
    speed = "fast";
  }
  const { DOM, Runtime, Input } = session;

  let targetId = "default";
  const active = sessionRegistry.getActive(getConfigAgentId(config));
  if (active) targetId = active.targetId;

  const { frameTree } = await session.Page.getFrameTree();
  const url = frameTree.frame.url;

  // ── Scroll a specific element into view ────────────────────────────────────
  if (id || label) {
    const { sendToExtension } = await import("../cdp/helpers.js");
    await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: 'scrolling to element...' } });
    let map = getCachedActionMap(targetId, url);
    if (!map) {
      const _emptyMap: import('../cdp/walker.js').ActionMap = { url, title: '', elements: [], targetId };
      map = await withTimeout(buildActionMap(session, { lite: true }, targetId), 5000, "scroll buildActionMap").catch(() => _emptyMap);
      if (map.elements.length > 0) cacheActionMap(targetId, map);
    }
    storeSnapshot(targetId, map.url, map.elements);

    let element = id
      ? map.elements.find((el) => el.id === id)
      : null;

    // Fast-fail for stale w: IDs
    if (!element && id && id.startsWith('w:')) {
      return { success: false, error_code: 'ELEMENT_NOT_FOUND', message: `[!] Ref '${id}' not found in current map. Call browser_map() first.` };
    }

    if (!element && label) {
      element = findBestMatch(map.elements, label);
      if (!element) {
        const { resolveByAria } = await import("../cdp/walker.js");
        const ariaEl = await withTimeout(resolveByAria(session, label), 2000, "resolveByAria label timeout").catch(() => null);
        if (ariaEl) {
          element = map.elements.find((el) => el.id === ariaEl.id) || null;
        }
      }
    }

    if (!element && id && !id.startsWith("w:")) {
      element = {
        id: id,
        label: id,
        selector: id,
        role: "element",
        group: "utility",
        depth: 0,
        fingerprint: "selector:" + id,
      } as any;
    }

    if (!element) {
      return {
        success: false,
        error_code: "ELEMENT_NOT_FOUND",
        message: `[!] Could not find element matching "${id ?? label}"`,
      };
    }

    const selector = safeSelector(element);
    if (!selector) {
      return { success: false, error_code: "SELECTOR_RESOLUTION_FAILED", message: `[!] Could not resolve safe selector for element` };
    }
    
    // ── 3. Element-level Scroll (CDP Wheel Event) ─────────────────────────
    const scrollSelector = selector;
    let elementFound = false;
    try {
      const res = await session.Runtime.evaluate({
        expression: `(function(sel) {
          const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
          };
        })(${JSON.stringify(scrollSelector)})`,
        returnByValue: true
      });
      const coords = res.result?.value;
      
      if (coords && coords.x !== undefined && coords.y !== undefined) {
        elementFound = true;
        // Dispatch CDP wheel event precisely over the element
        await session.Input.dispatchMouseEvent({
          type: "mouseWheel",
          x: coords.x,
          y: coords.y,
          deltaX: direction === "right" ? distance : (direction === "left" ? -distance : 0),
          deltaY: direction === "down" ? distance : (direction === "up" ? -distance : 0)
        });
        await new Promise(r => setTimeout(r, 100)); // allow scroll to settle
      }
    } catch { /* ignore */ }

    if (!elementFound) {
      return { success: false, error_code: "SCROLL_TARGET_NOT_FOUND", message: `Element ${id ?? label} not found or not visible` };
    }

  } else {
    // ── Inertial Physics Scroll ────────────────────────────────────────────────
    const profiles = {
      human:  { steps: 12, easing: 'quarticOut', baseDelay: 16 },
      read:   { steps: 25, easing: 'linear',     baseDelay: 40 },
      fast:   { steps: 6,  easing: 'cubicOut',   baseDelay: 8  },
    };

    const profile = profiles[speed];
    const totalPx = direction === 'down' ? distance : direction === 'up' ? -distance : 0;
    const totalPxX = direction === 'right' ? distance : direction === 'left' ? -distance : 0;

    const map = getCachedActionMap(targetId, url);
    if (map) {
      storeSnapshot(targetId, map.url, map.elements);
    }

    const viewportRes = await session.Runtime.evaluate({
      expression: `JSON.stringify({ x: window.innerWidth / 2, y: window.innerHeight / 2 })`,
      returnByValue: true
    }).catch(() => null);
    const vp = viewportRes?.result?.value ? JSON.parse(viewportRes.result.value as string) : { x: 400, y: 400 };

    await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `scrolling page ${direction}` } });

    for (let i = 0; i < profile.steps; i++) {
      const t = (i + 1) / profile.steps;
      const eased = applyEasing(t, profile.easing);
      const prevEased = applyEasing(i / profile.steps, profile.easing);
      const chunkY = (eased - prevEased) * totalPx;
      const chunkX = (eased - prevEased) * totalPxX;

      await Input.dispatchMouseEvent({
        type: 'mouseWheel',
        x: vp.x, y: vp.y,
        deltaX: chunkX, deltaY: chunkY
      });
      await sleep(profile.baseDelay + Math.random() * 4);
    }
  }

  await sleep(40);
  await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } }).catch(() => {});

  logAction("browser_scroll", direction, `${distance}px`);

  return {
    success: true,
    scrolled: id ?? label ?? "window",
    direction,
    distance,
    dom_changed: true,
  };
}
