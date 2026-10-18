/**
 * Weavetab — tools/inspect.ts
 * browser_inspect: Return detailed CSS styles, computed styles, and event listeners for an element.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";
import { getCachedActionMap, cacheActionMap } from "../state/cache.js";
import { sessionRegistry } from "../state/session.js";
import { buildActionMap } from "../cdp/walker.js";

export interface InspectOptions {
  nodeId?: number;
  selector?: string;
  ref?: string;
}

export async function browserInspect(
  session: CDP.Client,
  options: InspectOptions,
  _config: Config
): Promise<{ success: boolean; data: any; message: string }> {
  let { nodeId, selector, ref } = options;

  if (!nodeId && !selector && !ref) {
    throw new Error("browser_inspect requires nodeId, selector, or ref");
  }

  const { DOM, CSS, DOMDebugger } = session;
  await DOM.enable();
  await DOM.getDocument({ depth: 0 }).catch(() => null);
  await CSS.enable().catch(() => {});

  let resolvedNodeId: number | null = nodeId || null;

  // Step 1: Resolve a live nodeId from any input
  if (!resolvedNodeId && ref) {
    const active = sessionRegistry.getActive(getConfigAgentId(_config));
    if (active) {
      let map = getCachedActionMap(active.targetId);
      if (!map) {
        try {
          map = await buildActionMap(session, { lite: true }, active.targetId);
          cacheActionMap(active.targetId, map);
        } catch { /* best-effort */ }
      }
      if (map) {
        const el = map.elements.find((e) => e.id === ref || e.id.endsWith(ref.startsWith("w:") ? ref.slice(2) : ref));
        if (el?.backendNodeId) {
          const desc = await DOM.describeNode({ backendNodeId: el.backendNodeId }).catch(() => null);
          if (desc?.node?.nodeId) resolvedNodeId = desc.node.nodeId;
        }
        if (!resolvedNodeId && el?.selector) {
          selector = el.selector;
        }
        if (!resolvedNodeId && ref) {
          const rawId = ref.startsWith("w:") ? ref.slice(2) : ref;
          selector = selector || `[data-wt-id="${rawId}"]`;
        }
      }
    }
  }

  if (!resolvedNodeId && selector) {
    const res = await session.Runtime.evaluate({
      expression: `(function(sel) {
        var els = document.querySelectorAll(sel);
        for (var i = 0; i < els.length; i++) {
          if (!els[i].closest('#wt-shadow-host, [data-wt-ignore]')) {
            return els[i];
          }
        }
        return els[0] || null;
      })(${JSON.stringify(selector)})`,
    });
    if (res.result?.objectId) {
      const nodeRes = await DOM.requestNode({ objectId: res.result.objectId }).catch(() => null);
      if (nodeRes?.nodeId) resolvedNodeId = nodeRes.nodeId;
    }
  }

  if (!resolvedNodeId) {
    throw new Error("Could not resolve element to a node ID");
  }

  // Step 2: Fetch box model, computed styles, and event listeners in parallel
  const boxModel = await DOM.getBoxModel({ nodeId: resolvedNodeId }).catch(() => null);

  function reconstructShorthand(prefix: 'margin' | 'padding', styles: Record<string, string>): string | undefined {
    const t = styles[`${prefix}-top`];
    const r = styles[`${prefix}-right`];
    const b = styles[`${prefix}-bottom`];
    const l = styles[`${prefix}-left`];
    if (t === undefined && r === undefined && b === undefined && l === undefined) return undefined;
    if (t === b && r === l) return t === r ? t : `${t} ${r}`;
    if (r === l) return `${t} ${r} ${b}`;
    return `${t} ${r} ${b} ${l}`;
  }

  // Try CSS.getComputedStyleForNode first (CDP-native), fall back to Runtime.evaluate
  let computedStylesData: Record<string, string> | null = null;
  const cssResult = await CSS.getComputedStyleForNode({ nodeId: resolvedNodeId }).catch(() => null);
  if (cssResult?.computedStyle) {
    const INTERESTING = [
      'display','position','width','height','color','background-color','font-size','visibility','opacity','z-index','pointer-events',
      'margin-top','margin-right','margin-bottom','margin-left',
      'padding-top','padding-right','padding-bottom','padding-left'
    ];
    const rawStyles: Record<string, string> = cssResult.computedStyle
      .filter((s: any) => INTERESTING.includes(s.name))
      .reduce((acc: Record<string, string>, curr: any) => ({ ...acc, [curr.name]: curr.value }), {} as Record<string, string>);

    const margin = reconstructShorthand('margin', rawStyles);
    const padding = reconstructShorthand('padding', rawStyles);
    computedStylesData = {
      display: rawStyles.display,
      position: rawStyles.position,
      width: rawStyles.width,
      height: rawStyles.height,
      ...(margin ? { margin } : {}),
      ...(padding ? { padding } : {}),
      color: rawStyles.color,
      'background-color': rawStyles['background-color'],
      'font-size': rawStyles['font-size'],
      visibility: rawStyles.visibility,
      opacity: rawStyles.opacity,
      'z-index': rawStyles['z-index'],
      'pointer-events': rawStyles['pointer-events']
    };
  }
  if (!computedStylesData && selector) {
    // Fallback: use window.getComputedStyle via Runtime.evaluate
    const { result: fallbackRes } = await session.Runtime.evaluate({
      expression: `(function(sel) {
        var el = document.querySelector(sel);
        if (!el) return null;
        var s = window.getComputedStyle(el);
        var KEYS = ['display','position','width','height','margin','padding','color','background-color','font-size','visibility','opacity','z-index','pointer-events'];
        var r = {};
        for (var i = 0; i < KEYS.length; i++) r[KEYS[i]] = s.getPropertyValue(KEYS[i]);
        return JSON.stringify(r);
      })(${JSON.stringify(selector)})`,
      returnByValue: true,
    }).catch(() => ({ result: { value: null } }));
    if (fallbackRes?.value) {
      try { computedStylesData = JSON.parse(fallbackRes.value as string); } catch {}
    }
  }

  let listeners: any[] = [];
  try {
    const resolved = await DOM.resolveNode({ nodeId: resolvedNodeId });
    if (resolved.object?.objectId) {
      const evtRes = await DOMDebugger.getEventListeners({ objectId: resolved.object.objectId, depth: 1, pierce: true }).catch(() => null);
      if (evtRes?.listeners) {
        listeners = evtRes.listeners.map(l => ({ type: l.type, useCapture: l.useCapture, passive: l.passive }));
      }
    }
  } catch (e) {
    // Ignore DOMDebugger errors
  }

  const data = {
    boxModel: boxModel?.model ? {
      width: boxModel.model.width,
      height: boxModel.model.height,
      content: boxModel.model.content,
    } : null,
    computedStyles: computedStylesData,
    eventListeners: listeners
  };

  return { success: true, data, message: "inspected element" };
}
