// src/tools/click.ts
// Priority 2: Sub-10ms Click Path & Predictive Action Queue

import CDP from "chrome-remote-interface";
import { buildActionMap, findAllMatches, safeSelector, toMarkdownTable, resolveByAria, type ActionElement } from "../cdp/walker.js";
import { checkDomain } from "../security/blacklist.js";
import { logAction } from "../audit/logger.js";
import { recordAction, detectLoop, getLoopDiagnostics } from "../intelligence/trail.js";
import { waitForDOMStable } from "../sensors/guard.js";
import { waitForNetworkIdle } from "../sensors/wait.js";
import { ghostMove, waitForReading } from "../overlay/ghost.js";
import { getCachedActionMap, cacheActionMap, getCachedBoxModel, cacheBoxModel } from "../state/cache.js";
import { storeSnapshot, computeDelta } from "../state/delta.js";
import { hasOpenDialog } from "./dialog.js";
import { sessionRegistry } from "../state/session.js";
import { appendKnowledgeHint } from "../intelligence/hints.js";
import { sendToExtension } from "../cdp/helpers.js";
import { labelCache } from "../cdp/label_cache.js";
import type { Config } from "../config/loader.js";
import { getBestSelectorForIntent, logMemorySuccess, logMemoryFailure, type SelectorFingerprint } from "../intelligence/sessionMemory.js";
import { verifyActionability, quickHitCheck, type ActionabilityResult } from "../sensors/actionability.js";

export interface WeaveError {
  success: false;
  error_code: string;
  message: string;
  suggestion?: string;
  human_needed?: boolean;
  tab_id?: string;
  url?: string;
}

export interface ClickResult {
  success: true;
  clicked: string;
  ref: string;
  execution_ms: number;
  tab_id: string;
  url: string;
  title: string;
  url_changed: boolean;
  /** Only present when include_map:true was passed or url_changed is true. */
  page_map?: string;
  dom_changed: boolean;
  stuck_warning: boolean;
  stuck_hint?: string;
  sniper_warning?: string;
}

/** Converts SelectorFingerprint (sessionMemory) to the format verifyActionability expects. */
function fpToOpts(fingerprint?: SelectorFingerprint): { tag?: string; role?: string } | undefined {
  if (!fingerprint) return undefined;
  return { tag: fingerprint.tag, role: fingerprint.role };
}

/** Formats an OccluderInfo into a human-readable string for error messages. */
function describeOccluder(occ: NonNullable<ActionabilityResult['occludedBy']>): string {
  const id = occ.id ? `#${occ.id}` : '';
  const cls = occ.className ? `.${occ.className.split(' ')[0]}` : '';
  const label = occ.ariaLabel ? ` "${occ.ariaLabel}"` : '';
  return `<${occ.tag}${id}${cls}${label}> intercepts pointer events`;
}

export async function weaveClick(
  session: CDP.Client,
  args: { id?: string; label?: string; intent?: string; backendNodeId?: number; x?: number; y?: number; include_map?: boolean },
  config: Config
): Promise<ClickResult | WeaveError> {
  const { id, label, intent, backendNodeId: directNodeId } = args;
  const { Page, DOM, Input } = session;
  const startMs = Date.now();
  const clientMatch = sessionRegistry.getAll().find(c => c.session === session);
  const targetId = clientMatch?.targetId ?? (session as any).targetId ?? "default";
  
  // Track URL before click
  const initialUrl = (await Page.getFrameTree()).frameTree.frame.url;
  
  // 1. Resolve Element and Selector
  let map = getCachedActionMap(targetId, initialUrl);
  if (!map) {
    map = await buildActionMap(session, { lite: true }, targetId);
    cacheActionMap(targetId, map);
  }
  await storeSnapshot(targetId, initialUrl, map.elements);
  let element: ActionElement | undefined;
  let sniperWarning = "";
  let usedMemoryIntent = false;
  let coords: any = null;

  const urlObj = new URL(initialUrl);
  const hostname = urlObj.hostname;
  const pathname = urlObj.pathname;

  // FAST PATH: Memory Intent Intercept
  if (intent && !id && !label) {
    const memHit = await getBestSelectorForIntent(hostname, intent, pathname);
    if (memHit) {
      const actCheck = await verifyActionability(session, memHit.selector, {
        fingerprint: fpToOpts(memHit.fingerprint),
        stabilityTimeoutMs: config.actionabilityTimeoutMs ?? 400,
        totalTimeoutMs: (config.actionabilityTimeoutMs ?? 400) * 3,
      });
      if (actCheck.status === 'ACTIONABLE') {
        args.id = memHit.selector;
        usedMemoryIntent = true;
        sniperWarning = `(Memory Intercept: Skipped DOM evaluation and used learned selector for intent: '${intent}')`;
        coords = { x: actCheck.x, y: actCheck.y, visible: true };
        element = {
          id: memHit.selector,
          label: intent,
          x: actCheck.x,
          y: actCheck.y,
          selector: memHit.selector,
          role: "button",
          group: "utility",
          depth: 0,
          fingerprint: "memory:" + memHit.selector,
        } as any;
      } else if (actCheck.status === 'OCCLUDED') {
        const occ = actCheck.occludedBy;
        // WeaveTab-owned blockers are transparent — retry as actionable if only WT nodes blocked
        if (!occ?.isWeavetabOwned) {
          return {
            success: false,
            error_code: "ELEMENT_OCCLUDED_BY",
            message: `[!] ${describeOccluder(occ!)}. Handle the blocking element first.`,
          };
        }
      }
    }
  }

  // SLOW PATH: If not using Memory Intent Fast-Path
  if (!usedMemoryIntent) {
    const query = label || intent;

    if (args.id) {
      const reqId = args.id;
      element = map.elements.find((el) => el.id === reqId);

      // If not found in cache, rebuild map once to catch recent DOM updates or cache misses
      if (!element && reqId.startsWith("w:")) {
        map = await buildActionMap(session, { lite: true }, targetId);
        cacheActionMap(targetId, map);
        element = map.elements.find((el) => el.id === reqId);
      }

      // Fast-fail if still not found
      if (!element && reqId.startsWith("w:")) {
        return {
          success: false,
          error_code: "ELEMENT_NOT_FOUND",
          message: `[!] Ref '${reqId}' is no longer in the current page map — the DOM was updated since browser_map was called. Call browser_map() to get fresh ref IDs.`,
        };
      }

      if (!element && (reqId.startsWith("#") || reqId.startsWith(".") || reqId.includes("[") || reqId.includes(">") || reqId.includes(" "))) {
        const actCheck = await verifyActionability(session, reqId, {
          stabilityTimeoutMs: config.actionabilityTimeoutMs ?? 400,
          totalTimeoutMs: (config.actionabilityTimeoutMs ?? 400) * 3,
        });
        if (actCheck.status === 'ACTIONABLE') {
          element = {
            id: reqId,
            label: 'selector-match',
            x: actCheck.x,
            y: actCheck.y,
            selector: reqId,
            role: "button",
            group: "utility",
            depth: 0,
            fingerprint: "selector:" + reqId,
          } as any;
        } else if (actCheck.status === 'OCCLUDED' && !actCheck.occludedBy?.isWeavetabOwned) {
          return { success: false, error_code: "ELEMENT_OCCLUDED_BY", message: `[!] ${describeOccluder(actCheck.occludedBy!)} — element ${reqId} is blocked.` };
        }
      }
    } else if (label) {
      const cachedRef = labelCache.get(initialUrl, label);
      if (cachedRef) {
        element = map.elements.find(e => e.id === cachedRef);
        if (element) {
          sniperWarning = `(Cache Hit: Clicked label '${label}' via LRU cache for fast resolution)`;
        }
      }
      if (!element) {
        const matches = findAllMatches(map.elements, label);
        if (matches.length > 0) {
          element = matches[0];
          labelCache.set(initialUrl, label, element!.id);
        } else {
          // Aria fallback
          const ariaEl = await resolveByAria(session, label);
          if (ariaEl) {
            element = { ...ariaEl, role: "button", group: "utility", fingerprint: "aria", depth: 0 } as any;
            labelCache.set(initialUrl, label, element!.id);
          } else {
            return { success: false, error_code: "ELEMENT_NOT_FOUND", message: `[!] Could not find any clickable element matching label: '${label}'` };
          }
        }
      }
    } else if (intent) {
      const matches = findAllMatches(map.elements, intent);
      if (matches.length > 0) {
        element = matches[0];
      } else {
        const ariaEl = await resolveByAria(session, intent);
        if (ariaEl) {
          element = { ...ariaEl, role: "button", group: "utility", fingerprint: "aria", depth: 0 } as any;
        } else {
          return { success: false, error_code: "ELEMENT_NOT_FOUND", message: `[!] Could not resolve intent '${intent}' to any element. Try browser_map.` };
        }
      }
    }

    if (!element && args.x !== undefined && args.y !== undefined) {
      element = {
        id: "coords",
        label: `coords(${args.x},${args.y})`,
        x: args.x,
        y: args.y,
        role: "point",
        group: "utility",
        depth: 0,
        fingerprint: "coords"
      } as any;
    }

    if (!element && (label || intent)) {
      const ariaMatch = await resolveByAria(session, label || intent || "");
      if (ariaMatch) {
        element = {
          id: ariaMatch.id,
          label: ariaMatch.label,
          x: ariaMatch.x,
          y: ariaMatch.y,
          selector: ariaMatch.selector,
          role: "button",
          group: "utility",
          depth: 0,
          fingerprint: "aria:" + ariaMatch.label,
        } as any;
      }
    }

    if (!element) {
      if (intent && args.id) {
        await logMemoryFailure(hostname, intent, args.id, "DEAD_SELECTOR", pathname);
      }
      return { success: false, error_code: "ELEMENT_NOT_FOUND", message: `[!] Could not find target` };
    }

    const loopDiag = getLoopDiagnostics("browser_click", element.id);
    if (loopDiag.severity === "critical") {
      return { success: false, error_code: "STUCK_LOOP_WARNING", message: `[!] Loop detected: You have tried to click [${element.id}] ${loopDiag.strikes} times without success. Call browser_reset_loop_counter if this is a new task.` };
    }
    if (loopDiag.severity === "warning") {
      logAction("browser_click", element.id, `loop warning: ${loopDiag.strikes} consecutive strikes on [${element.id}]`);
    }

    // Resolve coordinates for slow-path element — uses full Playwright strategy engine
    if (element.id !== "coords") {
      const selector = safeSelector(element);
      if (selector) {
        const actCheck = await verifyActionability(session, selector, {
          stabilityTimeoutMs: config.actionabilityTimeoutMs ?? 400,
          totalTimeoutMs: (config.actionabilityTimeoutMs ?? 400) * 4,
        });

        if (actCheck.status === 'ACTIONABLE') {
          coords = { x: actCheck.x, y: actCheck.y, visible: true };
        } else if (actCheck.status === 'OCCLUDED') {
          if (actCheck.occludedBy?.isWeavetabOwned) {
            // WeaveTab's own overlay — treat as clear, use computed coords
            coords = { x: actCheck.x, y: actCheck.y, visible: true };
          } else {
            return { success: false, error_code: "ELEMENT_OCCLUDED_BY", message: `[!] ${describeOccluder(actCheck.occludedBy!)} — ${selector} is blocked.` };
          }
        } else if (actCheck.status === 'NOT_FOUND') {
          return { success: false, error_code: "ELEMENT_NOT_FOUND", message: `[!] Element ${selector} was in the cached map but no longer exists in the DOM. Run browser_map again to refresh refs.` };
        } else if (actCheck.status === 'INVISIBLE') {
          return { success: false, error_code: "ELEMENT_INVISIBLE", message: `[!] Element ${selector} has zero dimensions (hidden or collapsed). Use browser_inspect to check display/visibility, or scroll to reveal it.` };
        } else if (actCheck.status === 'FINGERPRINT_MISMATCH') {
          return { success: false, error_code: "FINGERPRINT_MISMATCH", message: `[!] Element ${selector} no longer matches its recorded tag/role fingerprint — the DOM was likely rebuilt. Run browser_map to get fresh refs.` };
        } else if (actCheck.status === 'UNSTABLE') {
          // Still unstable after full backoff — use raw cached coords but warn
          if (element.x !== undefined && element.y !== undefined) {
            coords = { x: element.x, y: element.y, visible: true };
          }
        }
      }
    }

    if (!coords) {
      if (element.x !== undefined && element.y !== undefined) {
        coords = { x: element.x, y: element.y, visible: true };
      } else if (args.x !== undefined && args.y !== undefined) {
        coords = { x: args.x, y: args.y, visible: true };
      } else {
        return { success: false, error_code: "COORD_RESOLUTION_FAILED", message: `[!] Could not resolve coordinates for ${element.label}` };
      }
    }
  }

  let neededScroll = false; // Note: scrolling is now handled primarily inside checkActionability

  const { x, y } = coords;

  // 3. Execute interaction with Human Simulation (Move + Hardware Click)
  //    Pre-dispatch hit check (Playwright Step 6) runs before every mouse event.
  const element_ = element!;
  async function performClick(cx: number, cy: number): Promise<void> {
    await ghostMove(session, cx, cy, config, element_.label);
    sendToExtension(session, { type: 'Weavetab_STATE', cursor: { x: cx, y: cy }, state: 'clicking', ripple: { cx, cy } }).catch(() => {});

    // ── Pre-dispatch hit-target check (Playwright Step 6) ──────────────────
    // Verify the coordinate is still clear right before the event fires.
    // This catches overlays/modals that appeared since verifyActionability ran.
    const targetSel = safeSelector(element_) ?? "";
    if (targetSel) {
      const hitCheck = await quickHitCheck(session, cx, cy, targetSel);
      if (!hitCheck.clear) {
        // Raise to performClick caller so the retry loop can try another alignment
        throw Object.assign(new Error(hitCheck.blockerDescription ?? "hit-target blocked"), { code: "HIT_TARGET_BLOCKED" });
      }
    }

    if (!config.headless) await new Promise(r => setTimeout(r, 30 + Math.random() * 50));
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1, pointerType: 'mouse' });
    await new Promise(r => setTimeout(r, 30 + Math.random() * 40));
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1, pointerType: 'mouse' });
  }

  let scrollYBefore = 0;
  try {
    const r = await session.Runtime.evaluate({ expression: 'Math.round(window.scrollY)', returnByValue: true });
    scrollYBefore = (r?.result?.value as number) || 0;
  } catch { /* ignore */ }

  async function isClickStuck(currentUrl: string): Promise<{ stuck: boolean; url: string; newMap: any; canvas_hint?: string; dialog_open?: boolean }> {
    // Check if a dialog was opened by the click immediately. If a dialog is open,
    // the click succeeded in triggering an action. Waiting for DOM stable will
    // just hang for 5-10s because Runtime.evaluate blocks on JS dialogs.
    await new Promise(r => setTimeout(r, 100)); // give dialog time to trigger
    if (hasOpenDialog(session)) {
      return { stuck: false, url: currentUrl, newMap: null, dialog_open: true };
    }

    await Promise.all([
      waitForDOMStable(session, 50, 300),
      waitForNetworkIdle(session, 50, 200).catch(() => {})
    ]);
    const finalUrl = (await Page.getFrameTree()).frameTree.frame.url;

    // Fast path: URL changed → definitely not stuck, skip map rebuild
    if (finalUrl !== currentUrl) {
      labelCache.invalidate(currentUrl); // URL changed, invalidate old labels
      return { stuck: false, url: finalUrl, newMap: null };
    }

    // Canvas fast path: if the clicked element is a <canvas>, DOM will never change
    // because canvas is pixel-rendered. Treat as success and guide agent to browser_canvas.
    if (element) {
      const sel = safeSelector(element);
      if (sel) {
        try {
          const { result: canvasCheck } = await session.Runtime.evaluate({
            expression: `(function(s) {
              const el = document.querySelector(s);
              if (!el) return false;
              // Check if the element itself or its closest ancestor is a canvas
              return el.tagName === 'CANVAS' || !!el.closest('canvas');
            })(${JSON.stringify(sel)})`,
            returnByValue: true,
          });
          if (canvasCheck?.value === true) {
            return {
              stuck: false,
              url: finalUrl,
              newMap: null,
              canvas_hint: 'Canvas element clicked. To read chart data or pixel content from this canvas, use browser_canvas with action:"get_image".'
            };
          }
        } catch { /* non-fatal */ }
      }
      // Also check by coordinates — elementFromPoint may return a canvas even if the AX ref is a wrapper
      if (coords) {
        try {
          const { result: coordCanvasCheck } = await session.Runtime.evaluate({
            expression: `(function(x, y) {
              const el = document.elementFromPoint(x, y);
              if (!el) return false;
              return el.tagName === 'CANVAS' || !!el.closest('canvas');
            })(${coords.x}, ${coords.y})`,
            returnByValue: true,
          });
          if (coordCanvasCheck?.value === true) {
            return {
              stuck: false,
              url: finalUrl,
              newMap: null,
              canvas_hint: 'Canvas element clicked via coordinates. To read chart data or pixel content from this canvas, use browser_canvas with action:"get_image".'
            };
          }
        } catch { /* non-fatal */ }
      }
    }

    let newMap = getCachedActionMap(targetId, finalUrl);
    if (!newMap) {
      newMap = await buildActionMap(session, { lite: true }, targetId);
      cacheActionMap(targetId, newMap);
    }
    const delta = computeDelta(targetId, initialUrl, newMap.elements);
    const changesCount = delta ? delta.added.length + delta.removed.length + delta.changed.length : 0;

    // Check scroll position — same-page anchors scroll without URL/DOM change
    let scrollYAfter = 0;
    try {
      const r = await session.Runtime.evaluate({ expression: 'Math.round(window.scrollY)', returnByValue: true });
      scrollYAfter = (r?.result?.value as number) || 0;
    } catch { /* ignore */ }
    const scrolled = Math.abs(scrollYAfter - scrollYBefore) > 50;

    // Radio/checkbox: computeDelta doesn't track `checked` attribute changes.
    // Do a targeted check on the clicked element to see if its checked state flipped.
    // Also handles clicking a <label for="..."> — follow the `for` attr to the real input.
    let radioCheckboxFixed = false;
    if (delta !== null && changesCount === 0 && !scrolled && element) {
      const sel = safeSelector(element);
      if (sel) {
        const { result: ckResult } = await session.Runtime.evaluate({
          expression: `(function(sel) {
            var el = document.querySelector(sel);
            if (!el) return null;
            // Check the element itself
            var t = (el.getAttribute('type') || '').toLowerCase();
            if (t === 'radio' || t === 'checkbox') return el.checked;
            // If it's a <label>, follow its 'for' attribute to the referenced input
            if (el.tagName === 'LABEL') {
              var forId = el.getAttribute('for');
              var target = forId ? document.getElementById(forId) : el.querySelector('input');
              if (target) {
                var t2 = (target.getAttribute('type') || '').toLowerCase();
                if (t2 === 'radio' || t2 === 'checkbox') return target.checked;
              }
            }
            return null;
          })(${JSON.stringify(sel)})`,
          returnByValue: true,
        }).catch(() => ({ result: { value: null } }));
        if (ckResult?.value !== null && ckResult?.value !== undefined) {
          radioCheckboxFixed = true;
        }
      }
    }

    // ARIA-state change: buttons that toggle a panel/menu/checked state change
    // aria-expanded, aria-selected, aria-pressed, or aria-checked without DOM-tree changes.
    // These are real successful clicks. Detect them before labelling as stuck.
    let ariaStateChanged = false;
    if (delta !== null && changesCount === 0 && !scrolled && !radioCheckboxFixed && element) {
      const sel = safeSelector(element);
      if (sel) {
        const { result: ariaRes } = await session.Runtime.evaluate({
          expression: `(function(sel) {
            const el = document.querySelector(sel);
            if (!el) return null;
            return JSON.stringify({
              expanded: el.getAttribute('aria-expanded'),
              selected: el.getAttribute('aria-selected'),
              pressed: el.getAttribute('aria-pressed'),
              checked: el.getAttribute('aria-checked'),
              current: el.getAttribute('aria-current')
            });
          })(${JSON.stringify(sel)})`,
          returnByValue: true,
        }).catch(() => ({ result: { value: null } }));
        // Any non-null aria state present means element is togglable; count it as changed
        if (ariaRes?.value) {
          try {
            const ariaState = JSON.parse(ariaRes.value as string);
            ariaStateChanged = Object.values(ariaState).some(v => v !== null);
          } catch { /* ignore */ }
        }
      }
    }

    // We no longer blindly consider "no DOM changes" as stuck because many static elements (tabs, menus, external links, pure JS)
    // do not mutate the DOM predictably. Only treat it as stuck if we explicitly failed to hit the target.
    const stuck = false;
    return { stuck, url: finalUrl, newMap };
  }

  let { x: clickX, y: clickY } = coords;
  let hitTargetBlocked = false;
  try {
    await performClick(clickX, clickY);
  } catch (err: any) {
    if (err?.code === "HIT_TARGET_BLOCKED") {
      hitTargetBlocked = true;
    } else {
      throw err;
    }
  }
  // ── Post-click: get page state (URL, map, DOM delta) ─────────────────────
  // The 'stuck' flag is purely informational — it powers stuck_warning in the
  // result. A dispatched, non-blocked click is NOT retried based on DOM delta
  // alone, because: (a) many real interactions produce no measurable DOM delta
  // (static buttons, CSS-only toggles, anchor scrolls); (b) retrying doubles the
  // click on checkboxes/accordions, net-zeroing the primary action.
  let postCheck = hitTargetBlocked
    ? { stuck: true, url: initialUrl, newMap: null }
    : await isClickStuck(initialUrl);

  // SPA JS-click fallback: only when the first click was genuinely hit-blocked
  if (hitTargetBlocked && element_) {
    const sel = safeSelector(element_);
    if (sel) {
      try {
        const { result: isButton } = await session.Runtime.evaluate({
          expression: `(function(s) {
            var el = document.querySelector(s);
            if (!el) return false;
            var tag = el.tagName.toLowerCase();
            var role = (el.getAttribute('role') || '').toLowerCase();
            if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'label' || tag === 'select') return true;
            if (['button','link','menuitem','menuitemcheckbox','menuitemradio',
                 'radio','checkbox','tab','option','treeitem','gridcell','switch'].includes(role)) return true;
            if (el.onclick || el.getAttribute('onclick')) return true;
            if (el.isContentEditable || tag === 'summary') return true;
            return false;
          })(${JSON.stringify(sel)})`,
          returnByValue: true,
        }).catch(() => ({ result: { value: false } }));

        if (isButton?.value) {
          await session.Runtime.evaluate({
            expression: `(function(s) {
              var el = document.querySelector(s);
              if (el) { el.focus(); el.click(); }
            })(${JSON.stringify(sel)})`,
            returnByValue: false,
          }).catch(() => {});
          await new Promise(r => setTimeout(r, 300));
          postCheck = { stuck: false, url: initialUrl, newMap: null };
        }
      } catch { /* non-fatal */ }
    }
  }

  const executionMs = Date.now() - startMs;
  const { stuck: isStuck, url: finalUrl, newMap } = postCheck;

  if (neededScroll) {
    try {
      const hostname = new URL(initialUrl).hostname;
      await appendKnowledgeHint(hostname, "elements on this site often need to be scrolled into view before clicking");
    } catch { /* ignore */ }
  }

  const stuckHint = postCheck.dialog_open
    ? 'A dialog opened. Use browser_dialog to interact with it.'
    : isStuck
      ? `Page did not respond to click (no visible DOM change). Try browser_pointer with raw coords (x: ${clickX}, y: ${clickY}) if the element is visible, or browser_eval to click it directly.`
      : undefined;

  // Logging success or action failure
  if (intent && (args.id || element_.selector)) {
    const finalSelector = args.id || element_.selector!;
    if (isStuck) {
      await logMemoryFailure(hostname, intent, finalSelector, "ACTION_FAILED", pathname);
    } else {
      await logMemorySuccess(hostname, intent, finalSelector, {
        role: element_.role,
        classes: element_.className ? element_.className.split(' ') : undefined,
        tag: element_.type, // assuming type roughly maps to tag
        structuralIdiom: element_.structuralIdiom
      }, pathname);
    }
  }

  recordAction({
    timestamp: new Date().toISOString(),
    tool: "browser_click",
    input: { ref: element_?.id ?? args.id ?? args.label, label: element_?.label },
    result: { success: true, stuck: isStuck },
  });

  if (isStuck) {
    return {
      success: false,
      error_code: "CLICK_NO_EFFECT",
      message: "The click executed but resulted in no visible changes to the page. It may have been intercepted by an overlay, or the element might require a different interaction.",
      suggestion: "Try looking for an invisible overlay blocking the click, or try using browser_eval to click it directly.",
      tab_id: targetId,
      url: finalUrl,
    } as WeaveError;
  }

  return {
    success: true,
    clicked: element_.label,
    ref: element_.id,
    execution_ms: executionMs,
    tab_id: targetId,
    url: finalUrl,
    title: newMap?.title || "",
    url_changed: finalUrl !== initialUrl,
    ...(args.include_map ? { page_map: newMap ? toMarkdownTable(newMap.elements, finalUrl, newMap.title) : "" } : {}),
    dom_changed: true,
    stuck_warning: false,
    ...(stuckHint ? { stuck_hint: stuckHint } : {}),
    ...(sniperWarning ? { sniper_warning: sniperWarning } : {}),
    ...((postCheck as any).canvas_hint ? { canvas_hint: (postCheck as any).canvas_hint } : {})
  };
}

