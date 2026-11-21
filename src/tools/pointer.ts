/**
 * Weavetab — tools/pointer.ts
 * Unified tool for all mouse/pointer interactions: click, double_click, hover, drag_and_drop.
 * Supports targeting by ref ID (e.g. w:42) or absolute coordinates (x, y).
 * Replaces mouse.ts, hover.ts, and drag.ts.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import { logAction } from "../audit/logger.js";
import { recordAction } from "../intelligence/trail.js";
import { ghostMove, ghostClick } from "../overlay/ghost.js";
import { waitForDOMStable } from "../sensors/guard.js";
import { buildActionMap, findAllMatches, resolveByAria, safeSelector } from "../cdp/walker.js";
import { getCachedActionMap, cacheActionMap } from "../state/cache.js";
import { computeDelta, storeSnapshot } from "../state/delta.js";
import { sessionRegistry } from "../state/session.js";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";
import { browserWait } from "./wait.js";

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

export interface PointerResult {
  success: boolean;
  action: string;
  x?: number;
  y?: number;
  end_x?: number;
  end_y?: number;
  execution_ms: number;
  tab_id: string;
  url: string;
  dom_changed?: boolean;
}

async function resolveRefToCoords(session: CDP.Client, targetId: string, ref: string, currentUrl?: string): Promise<{ x: number; y: number; selector: string } | null> {
  let map = getCachedActionMap(targetId, currentUrl);
  if (!map) {
    map = await buildActionMap(session, { lite: true }, targetId);
    cacheActionMap(targetId, map);
  }

  let element = map.elements.find((el) => el.id === ref || el.id === `w:${ref}`);
  if (!element && ref && !ref.startsWith("w:")) {
    element = {
      id: ref,
      label: ref,
      selector: ref,
      role: "element",
      group: "utility",
      depth: 0,
      fingerprint: "selector:" + ref,
    } as any;
  }
  if (!element) return null;

  const selector = safeSelector(element);
  if (!selector) return null;

  // Scroll element into view before resolving coordinates
  await session.Runtime.evaluate({
    expression: `(function(sel) {
      const el = document.querySelector(sel);
      if (el) {
        if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded();
        else el.scrollIntoView({behavior:'instant',block:'center'});
      }
    })(${JSON.stringify(selector)})`,
    returnByValue: true
  }).catch(() => {});
  await new Promise(r => setTimeout(r, 100));

  // Try the live index coords first
  const coordsRes = await session.Runtime.evaluate({
    expression: `(window.__wt_getCoords || window.__Weavetab_getCoords || function(){return null;})(${JSON.stringify(selector)})`,
    returnByValue: true
  }).catch(() => null);

  if (coordsRes?.result?.value) {
    const v = coordsRes.result.value;
    if (v.x !== 0 || v.y !== 0) return { x: v.x, y: v.y, selector };
  }

  // Fallback 1: use element bounding rect directly via CDP evaluate
  const bboxRes = await session.Runtime.evaluate({
    expression: `(function(sel) {
      const el = document.querySelector(sel);
      if (!el) return null;
      // Primary: getBoundingClientRect
      const r = el.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) {
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      }
      // Fallback for inline text elements (e.g. Wikipedia lang links).
      // Inline elements can have zero-size bounding rects but non-zero client rects
      // for their first text-box fragment.
      const rects = el.getClientRects();
      if (rects && rects.length > 0) {
        const fr = rects[0];
        if (fr.width > 0 || fr.height > 0) {
          return { x: Math.round(fr.left + fr.width / 2), y: Math.round(fr.top + fr.height / 2) };
        }
      }
      return null;
    })(${JSON.stringify(selector)})`,
    returnByValue: true
  }).catch(() => null);

  if (bboxRes?.result?.value) {
    const v = bboxRes.result.value;
    return { x: v.x, y: v.y, selector };
  }

  // Fallback 2: DOM.getBoxModel via CDP directly
  if (element.backendNodeId) {
    try {
      await session.DOM.getDocument({ depth: 0 }); // ensure DOM is enabled/active
      const box = await session.DOM.getBoxModel({ backendNodeId: element.backendNodeId });
      if (box && box.model && box.model.content && box.model.content.length === 8) {
        const c = box.model.content;
        const x = Math.round((c[0] + c[2]) / 2);
        const y = Math.round((c[1] + c[5]) / 2);
        if (x !== 0 || y !== 0) return { x, y, selector };
      }
    } catch { /* ignore box model errors */ }
  }

  // Fallback 3: Map coords (AX or live index from map time).
  // Note: elements genuinely positioned at (0,0) are valid targets and accepted.
  if (element.x !== undefined && element.y !== undefined) {
    return { x: element.x, y: element.y, selector };
  }

  return null;
}

export interface PointerStep {
  action?: "hover" | "click" | "double_click";
  ref?: string;
  selector?: string;
  target?: string;
  label?: string;
  x?: number;
  y?: number;
  holdMs?: number;
}

export interface PointerArgs {
  action?: "click" | "double_click" | "hover" | "move" | "drag_and_drop" | "hover_chain";
  ref?: string;
  selector?: string;
  target?: string;
  label?: string;  // supports label-based targeting
  x?: number;
  y?: number;
  end_ref?: string;
  end_x?: number;
  end_y?: number;
  waitForChild?: string; // for hover
  holdMs?: number; // for hover
  hover_chain?: Array<string | PointerStep>;
  chain?: Array<string | PointerStep>;
  clickFinal?: boolean;
  [key: string]: unknown;
}

export async function browserPointer(
  session: CDP.Client,
  args: PointerArgs,
  config: Config
): Promise<PointerResult> {
  let { action = "click", ref, selector, label, x, y, end_ref, end_x, end_y, waitForChild, holdMs = 200 } = args;

  // ── HOVER CHAIN / SUBMENU NAVIGATION (Photopea, Figma, Photoshop, Flyout Menus) ──
  const rawChain = args.hover_chain || args.chain;
  if (action === "hover_chain" || (rawChain && rawChain.length > 0)) {
    const chainItems: PointerStep[] = (rawChain || []).map((step, idx, arr) => {
      if (typeof step === "string") {
        const isLast = idx === arr.length - 1;
        return {
          action: isLast && args.clickFinal !== false ? "click" : "hover",
          ref: step,
          label: step,
          target: step
        };
      }
      return step;
    });

    const startMs = Date.now();
    const { Page, Input } = session;
    let targetId = "default";
    const active = sessionRegistry.getActive(getConfigAgentId(config));
    if (active) targetId = active.targetId;

    let lastX = 0, lastY = 0;
    for (let i = 0; i < chainItems.length; i++) {
      const step = chainItems[i]!;
      const stepTarget = step.ref || step.selector || step.target || step.label;
      let stepCoords: { x: number; y: number; selector: string } | null = null;

      if (step.x !== undefined && step.y !== undefined) {
        stepCoords = { x: step.x, y: step.y, selector: step.selector || '' };
      } else if (stepTarget) {
        stepCoords = await resolveRefToCoords(session, targetId, stepTarget).catch(() => null);
        if (!stepCoords) {
          // Submenu might have rendered after previous hover; quick retry with fresh map
          await new Promise(r => setTimeout(r, 80));
          await buildActionMap(session, { lite: true }, targetId).then(m => cacheActionMap(targetId, m)).catch(() => {});
          stepCoords = await resolveRefToCoords(session, targetId, stepTarget).catch(() => null);
        }
      }

      if (!stepCoords) {
        throw new Error(`[browser_pointer hover_chain] Could not resolve coordinates for chain step [${i}]: '${stepTarget}'`);
      }

      lastX = stepCoords.x;
      lastY = stepCoords.y;

      // Move pointer smoothly to element
      await ghostMove(session, stepCoords.x, stepCoords.y, config, step.label, "fast");
      await Input.dispatchMouseEvent({ type: "mouseMoved", x: stepCoords.x, y: stepCoords.y, pointerType: "mouse" });

      // Dispatch mouseenter/mouseover events for dynamic flyout/hover menus
      if (stepCoords.selector) {
        await session.Runtime.evaluate({
          expression: `(function(sel, cx, cy) {
            const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
            if (!el) return;
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true, clientX: cx, clientY: cy }));
            el.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true,  cancelable: true, clientX: cx, clientY: cy }));
            el.dispatchEvent(new MouseEvent('mousemove',  { bubbles: true,  cancelable: true, clientX: cx, clientY: cy }));
          })(${JSON.stringify(stepCoords.selector)}, ${stepCoords.x}, ${stepCoords.y})`,
          returnByValue: false
        }).catch(() => {});
      }

      const stepHold = step.holdMs ?? (i === chainItems.length - 1 ? 40 : 100);
      await new Promise(r => setTimeout(r, stepHold));

      // If action is click (e.g. final step in chain)
      if (step.action === "click") {
        await Input.dispatchMouseEvent({ type: "mousePressed", x: stepCoords.x, y: stepCoords.y, button: "left", clickCount: 1, pointerType: "mouse" });
        await new Promise(r => setTimeout(r, 40));
        await Input.dispatchMouseEvent({ type: "mouseReleased", x: stepCoords.x, y: stepCoords.y, button: "left", clickCount: 1, pointerType: "mouse" });
      } else if (step.action === "double_click") {
        await Input.dispatchMouseEvent({ type: "mousePressed", x: stepCoords.x, y: stepCoords.y, button: "left", clickCount: 1, pointerType: "mouse" });
        await Input.dispatchMouseEvent({ type: "mouseReleased", x: stepCoords.x, y: stepCoords.y, button: "left", clickCount: 1, pointerType: "mouse" });
        await new Promise(r => setTimeout(r, 60));
        await Input.dispatchMouseEvent({ type: "mousePressed", x: stepCoords.x, y: stepCoords.y, button: "left", clickCount: 2, pointerType: "mouse" });
        await Input.dispatchMouseEvent({ type: "mouseReleased", x: stepCoords.x, y: stepCoords.y, button: "left", clickCount: 2, pointerType: "mouse" });
      }
    }

    const execMs = Date.now() - startMs;
    const { frameTree: postFrameTree } = await Page.getFrameTree().catch(() => ({ frameTree: { frame: { url: '' } } }));
    return {
      success: true,
      action: "hover_chain",
      x: lastX,
      y: lastY,
      execution_ms: execMs,
      tab_id: targetId,
      url: postFrameTree.frame.url,
      dom_changed: true,
    };
  }
  
  if (selector && !ref) {
    ref = selector;
  } else if (args.target && !ref) {
    ref = args.target;
  }
  
  const startMs = Date.now();
  const { Page, Input, Runtime } = session;

  const timeoutMs = action === "drag_and_drop" ? 25000 : 15000;

  const { frameTree } = await withTimeout(Page.getFrameTree(), 5000, "browser_pointer getFrameTree");
  const initialUrl = frameTree.frame.url;

  let targetId = "default";
  const active = sessionRegistry.getActive(getConfigAgentId(config));
  if (active) targetId = active.targetId;

  // Resolve label to a ref ID before coordinate resolution,
  // mirroring the logic in browser_click.
  if (!ref && label && !x && !y) {
    let map = getCachedActionMap(targetId, initialUrl);
    if (!map) {
      map = await withTimeout(buildActionMap(session, { lite: true }, targetId), 6000, "buildActionMap label");
      cacheActionMap(targetId, map);
    }
    const matches = findAllMatches(map.elements, label);
    if (matches.length > 0) {
      ref = matches[0]!.id;
    } else {
      const ariaEl = await resolveByAria(session, label).catch(() => null);
      if (ariaEl) {
        ref = ariaEl.id;
      }
    }
    if (!ref) {
      throw new Error(`browser_pointer: Could not find element matching label: '${label}'`);
    }
  }

  // Resolve start coordinates
  let startX = x, startY = y, startSelector = "";
  if (ref) {
    let coords = await withTimeout(resolveRefToCoords(session, targetId, ref, initialUrl), 4000, "resolveRefToCoords");
    if (!coords) {
      await buildActionMap(session, { lite: true }, targetId).then(m => cacheActionMap(targetId, m));
      coords = await withTimeout(resolveRefToCoords(session, targetId, ref, initialUrl), 4000, "resolveRefToCoords retry");
    }
    if (!coords) {
      throw new Error(`Could not resolve coordinates for ref: ${ref}`);
    }
    startX = coords.x;
    startY = coords.y;
    startSelector = coords.selector;
  }

  if (startX === undefined || startY === undefined) {
    throw new Error(`browser_pointer requires either ref, label, or explicit (x, y) coordinates.`);
  }

  // Record DOM state before interaction
  let map = getCachedActionMap(targetId, initialUrl);
  if (!map) {
    map = await withTimeout(buildActionMap(session, { lite: true }, targetId), 6000, "buildActionMap");
    cacheActionMap(targetId, map);
  }
  storeSnapshot(targetId, map.url, map.elements);

  // Move to target using human-like motion
  await withTimeout((async () => {
    if (action === "hover" || action === "move") {
      await Promise.race([
        ghostMove(session, startX, startY, config),
        new Promise<void>(r => setTimeout(r, 3000)).then(() => ghostMove(session, startX, startY, config, undefined, "instant"))
      ]);
    } else {
      await ghostMove(session, startX, startY, config);
    }
  })(), 10000, "ghostMove");

  let preBox: { x: number; y: number; w: number; h: number; tag: string } | null = null;
  let isCanvasTarget = false;
  let resolvedEndX = end_x;
  let resolvedEndY = end_y;

  if (action === "move") {
    await Input.dispatchMouseEvent({ type: "mouseMoved", x: startX, y: startY, pointerType: "mouse" });
  } else if (action === "hover") {
    // Dispatch both mouseenter AND mouseover (some sites only listen to one)
    if (startSelector) {
      await session.Runtime.evaluate({
        expression: `(function(sel) {
          const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
          if (!el) return;
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true,  cancelable: true }));
        })(${JSON.stringify(startSelector)})`,
        returnByValue: true
      }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, holdMs));

    if (waitForChild) {
      await browserWait(session, { for: "element", value: waitForChild, timeout: 5000 }, config);
    }
  } else if (action === "click") {
    await ghostClick(session, startX, startY);
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: startX, y: startY, button: "left", clickCount: 1 });
  } else if (action === "double_click") {
    await ghostClick(session, startX, startY);
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: startX, y: startY, button: "left", clickCount: 1 });
    await new Promise(r => setTimeout(r, 100));
    await ghostClick(session, startX, startY, { clickCount: 2 });
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: startX, y: startY, button: "left", clickCount: 2 });
  } else if (action === "drag_and_drop") {
    let destX = end_x, destY = end_y;
    if (end_ref) {
      const destCoords = await withTimeout(
        resolveRefToCoords(session, targetId, end_ref),
        4000,
        "resolveRefToCoords end_ref"
      ).catch(() => null);
      if (!destCoords) {
        throw new Error(`Could not resolve coordinates for end_ref: ${end_ref}`);
      }
      destX = destCoords.x;
      destY = destCoords.y;
    }

    if (destX === undefined || destY === undefined) {
      throw new Error("drag_and_drop requires either end_ref or end_x/end_y");
    }
    resolvedEndX = destX;
    resolvedEndY = destY;

    // ── Pre-drag: snapshot the element bounding box for verification ──────
    const preDragBBox = await session.Runtime.evaluate({
      expression: `(function(sx, sy, sel) {
        var el = sel ? document.querySelector(sel) : document.elementFromPoint(sx, sy);
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), tag: el.tagName };
      })(${startX}, ${startY}, ${startSelector ? JSON.stringify(startSelector) : 'null'})`,
      returnByValue: true,
    }).catch(() => null);
    preBox = preDragBBox?.result?.value as { x: number; y: number; w: number; h: number; tag: string } | null;
    isCanvasTarget = preBox?.tag === 'CANVAS';

    // ── Strategy 1: CDP-native Input.dispatchDragEvent ────────────────────
    // Most reliable path for HTML5 DnD — Chrome handles the full
    // dragstart→dragover→drop→dragend lifecycle internally.
    // Only used for non-canvas targets (canvas apps don't use HTML5 DnD).
    let cdpDragWorked = false;
    if (!isCanvasTarget) {
      try {
        const dragData = {
          items: [] as any[],
          dragOperationsMask: 35, // copy(1) | link(2) | move(32)
        };

        await (Input as any).dispatchDragEvent({
          type: "dragEnter",
          x: startX,
          y: startY,
          data: dragData,
        });
        await new Promise(r => setTimeout(r, 50));

        const cdpDragSteps = 10;
        for (let i = 1; i <= cdpDragSteps; i++) {
          const t = i / cdpDragSteps;
          const mx = Math.round(startX + (destX - startX) * t);
          const my = Math.round(startY + (destY - startY) * t);
          await (Input as any).dispatchDragEvent({
            type: "dragOver",
            x: mx,
            y: my,
            data: dragData,
          });
          await new Promise(r => setTimeout(r, 30));
        }

        await (Input as any).dispatchDragEvent({
          type: "drop",
          x: destX,
          y: destY,
          data: dragData,
        });
        await new Promise(r => setTimeout(r, 50));

        await (Input as any).dispatchDragEvent({
          type: "dragEnd",
          x: destX,
          y: destY,
          data: dragData,
        });

        cdpDragWorked = true;
      } catch {
        // Input.dispatchDragEvent may not be supported; fall through.
      }
    }

    // ── Strategy 2: Full HTML5 DnD event sequence via JS injection ────────
    // For frameworks (React DnD, SortableJS, native drop zones).
    // Skipped for canvas targets — they don't use HTML5 DnD.
    if (!cdpDragWorked && !isCanvasTarget) {
      await session.Runtime.evaluate({
        expression: `(function(sx, sy, dx, dy, srcSel) {
          var src = srcSel ? document.querySelector(srcSel) : document.elementFromPoint(sx, sy);
          var dest = document.elementFromPoint(dx, dy);
          if (!src) return;

          var dt;
          try { dt = new DataTransfer(); } catch(e) {
            dt = { items: [], types: [], files: [],
              setData: function(k,v){ this.types.push(k); this._data = this._data||{}; this._data[k]=v; },
              getData: function(k){ return (this._data||{})[k]||''; },
              clearData: function(){}, dropEffect:'move', effectAllowed:'all' };
          }
          dt.effectAllowed = 'all';

          function fire(el, type, related) {
            if (!el) return true;
            var evt = new DragEvent(type, {
              bubbles: true, cancelable: true, view: window,
              clientX: type.startsWith('drag') && (type==='dragstart'||type==='drag'||type==='dragend') ? sx : dx,
              clientY: type.startsWith('drag') && (type==='dragstart'||type==='drag'||type==='dragend') ? sy : dy,
              dataTransfer: dt,
              relatedTarget: related || null
            });
            return el.dispatchEvent(evt);
          }

          fire(src, 'dragstart', null);
          fire(dest, 'dragenter', src);
          for (var i = 0; i < 3; i++) { fire(dest, 'dragover', src); }
          fire(dest, 'drop', src);
          fire(src, 'dragend', dest);
        })(${startX}, ${startY}, ${destX}, ${destY}, ${startSelector ? JSON.stringify(startSelector) : 'null'})`,
        returnByValue: false,
      }).catch(() => {});
    }

    // Strategy 3: CDP pointer/mouse sequence (only when Strategy 1 didn't succeed, or on canvas)
    if (!cdpDragWorked || isCanvasTarget) {
      await Input.dispatchMouseEvent({ type: "mousePressed", x: startX, y: startY, button: "left", clickCount: 1, pointerType: "mouse" });
      await new Promise(r => setTimeout(r, 120));

      const dragSteps = 16;
      for (let i = 1; i <= dragSteps; i++) {
        const t = i / dragSteps;
        const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const mx = Math.round(startX + (destX - startX) * eased);
        const my = Math.round(startY + (destY - startY) * eased);

        await Input.dispatchMouseEvent({ type: "mouseMoved", x: mx, y: my, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse" });

        if (isCanvasTarget) {
          await session.Runtime.evaluate({
            expression: `(function(sx, sy, mx, my) {
              var el = document.elementFromPoint(sx, sy) || document.elementFromPoint(mx, my);
              if (!el) return;
              el.dispatchEvent(new PointerEvent('pointermove', {
                bubbles: true, cancelable: true, view: window,
                pointerId: 1, pointerType: 'mouse', isPrimary: true,
                width: 1, height: 1, pressure: 0.5,
                button: -1, buttons: 1,
                clientX: ${mx}, clientY: ${my}
              }));
            })(${startX}, ${startY}, ${mx}, ${my})`,
            returnByValue: false,
          }).catch(() => {});
        }

        await new Promise(r => setTimeout(r, 18));
      }

      await new Promise(r => setTimeout(r, 80));
      await Input.dispatchMouseEvent({ type: "mouseReleased", x: destX, y: destY, button: "left", clickCount: 1, pointerType: "mouse" });

      if (isCanvasTarget) {
        await session.Runtime.evaluate({
          expression: `(function(sx, sy, dx, dy) {
            var el = document.elementFromPoint(sx, sy) || document.elementFromPoint(dx, dy);
            if (!el) return;
            el.dispatchEvent(new PointerEvent('pointerup', {
              bubbles: true, cancelable: true, view: window,
              pointerId: 1, pointerType: 'mouse', isPrimary: true,
              width: 1, height: 1, pressure: 0, button: 0, buttons: 0,
              clientX: ${destX}, clientY: ${destY}
            }));
          })(${startX}, ${startY}, ${destX}, ${destY})`,
          returnByValue: false,
        }).catch(() => {});
      }
    }

    // Clean up stuck drag CSS classes
    await session.Runtime.evaluate({
      expression: `(function() {
        const classes = ['dragging', 'drag-active', 'ui-draggable-dragging', 'is-dragging', 'being-dragged'];
        const attrs = ['data-dragging'];
        classes.forEach(cls => {
          document.querySelectorAll('.' + cls).forEach(el => el.classList.remove(cls));
        });
        attrs.forEach(attr => {
          document.querySelectorAll('[' + attr + ']').forEach(el => el.removeAttribute(attr));
        });
      })()`,
      returnByValue: false,
    }).catch(() => {});
  }

  // Settle
  await waitForDOMStable(session, 50, 1500).catch(() => {});

  const { frameTree: postFrameTree } = await withTimeout(Page.getFrameTree(), 5000, "post-action getFrameTree");
  const finalUrl = postFrameTree.frame.url;

  // Calculate DOM changes (timeout-safe)
  const newMap = await buildActionMap(session, { lite: true }, targetId).catch(() => null) || map;
  cacheActionMap(targetId, newMap);
  const diff = computeDelta(targetId, newMap.url, newMap.elements);
  const changesCount = diff ? diff.added.length + diff.removed.length + diff.changed.length : 0;
  const domChanged = changesCount > 0 || finalUrl !== initialUrl;

  let dragVerified: boolean | undefined = undefined;
  if (action === "drag_and_drop" && startX !== undefined && startY !== undefined && resolvedEndX !== undefined && resolvedEndY !== undefined) {
    await new Promise(r => setTimeout(r, 200));

    const postDragBBox = await session.Runtime.evaluate({
      expression: `(function(dx, dy, sel) {
        var el = sel ? document.querySelector(sel) : document.elementFromPoint(dx, dy);
        if (!el) return null;
        var r = el.getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      })(${resolvedEndX}, ${resolvedEndY}, ${startSelector ? JSON.stringify(startSelector) : 'null'})`,
      returnByValue: true,
    }).catch(() => null);
    const postBox = postDragBBox?.result?.value as { x: number; y: number; w: number; h: number } | null;

    const dropProbe = await session.Runtime.evaluate({
      expression: `(function(dx, dy) {
        var el = document.elementFromPoint(dx, dy);
        if (!el) return { found: false };
        var text = (el.textContent || '').trim().substring(0, 100);
        var classes = el.className || '';
        return { found: true, text: text, classes: typeof classes === 'string' ? classes : '' };
      })(${resolvedEndX}, ${resolvedEndY})`,
      returnByValue: true,
    }).catch(() => null);
    const probe = dropProbe?.result?.value as { found: boolean; text?: string; classes?: string } | null;

    if (postBox && startSelector && preBox) {
      const movedX = Math.abs(postBox.x - preBox.x);
      const movedY = Math.abs(postBox.y - preBox.y);
      const dragDist = Math.sqrt(Math.pow(resolvedEndX - startX, 2) + Math.pow(resolvedEndY - startY, 2));
      dragVerified = (movedX + movedY) > Math.max(5, dragDist * 0.3);
    } else if (domChanged) {
      dragVerified = true;
    } else if (probe?.found) {
      const dropIndicators = ['dropped', 'drop-success', 'drag-complete', 'moved'];
      const probeText = (probe.text || '').toLowerCase();
      const probeClasses = (probe.classes || '').toLowerCase();
      dragVerified = dropIndicators.some(ind => probeText.includes(ind) || probeClasses.includes(ind));
    }

    if (dragVerified === undefined && !domChanged) {
      dragVerified = false;
    }
  }

  const executionMs = Date.now() - startMs;
  logAction("browser_pointer", action, `ref:${ref || 'none'} (${startX}, ${startY}) (exec: ${executionMs}ms)${dragVerified !== undefined ? ` verified:${dragVerified}` : ''}`);
  
  recordAction({
    timestamp: new Date().toISOString(),
    tool: "browser_pointer",
    input: args,
    result: { success: true, drag_verified: dragVerified },
  });

  return {
    success: true,
    action,
    x: startX,
    y: startY,
    end_x: resolvedEndX,
    end_y: resolvedEndY,
    execution_ms: executionMs,
    tab_id: targetId,
    url: finalUrl,
    dom_changed: domChanged,
    ...(dragVerified !== undefined ? { drag_verified: dragVerified } : {}),
  } as PointerResult;
}
