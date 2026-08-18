/**
 * Weavetab — tools/highlight.ts
 * browser_highlight: draws a CSS shimmer animation over the element that auto-fades.
 * Falls back through 5 strategies so w:NN refs always resolve.
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";

export interface HighlightOptions {
  selector?: string;
  id?: string;
  ref?: string;
  target?: string;
  label?: string;
  nodeId?: number;
  color?: string;
}

export async function browserHighlight(
  session: CDP.Client,
  options: HighlightOptions,
  _config: Config
): Promise<{ success: boolean; message: string }> {
  const { selector, nodeId } = options;

  // Inject shimmer keyframe once
  await session.Runtime.evaluate({
    expression: `(function(){
      if (!document.getElementById('wt-shimmer-style')) {
        var s = document.createElement('style');
        s.id = 'wt-shimmer-style';
        s.textContent = '@keyframes wt-shimmer{0%{opacity:0;background-position:-200% 0}15%{opacity:0.9}40%{opacity:0.7}85%{opacity:0.3}100%{opacity:0;background-position:200% 0}}';
        (document.head || document.documentElement).appendChild(s);
      }
    })()`,
    returnByValue: true,
  }).catch(() => {});

  // Draw shimmer overlay at raw coordinates — works without any DOM query
  function makeCoordShimmer(x: number, y: number, w: number, h: number): string {
    return `(function(){
      var div = document.createElement('div');
      div.style.cssText = 'position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:2147483647;pointer-events:none;background:linear-gradient(120deg,transparent 30%,rgba(139,92,246,0.3) 50%,transparent 70%);background-size:200% 100%;animation:wt-shimmer 0.5s ease-out forwards;border:1.5px solid rgba(139,92,246,0.6);border-radius:3px;box-shadow:0 0 8px rgba(139,92,246,0.25);';
      (document.getElementById('Weavetab-root')?.shadowRoot || document.getElementById('Weavetab-root') || document.body).appendChild(div);
      setTimeout(function(){ if(div.parentNode) div.parentNode.removeChild(div); }, 600);
      return true;
    })()`;
  }

  // Draw shimmer by querying a CSS selector
  function makeSelectorShimmer(sel: string): string {
    const escaped = sel.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `(function(){
      var el;
      try { el = document.querySelector('${escaped}'); } catch(e) {}
      if (!el && window.__Weavetab_shadowQuery) {
        try { el = window.__Weavetab_shadowQuery('${escaped}'); } catch(e) {}
      }
      if (!el) return false;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      var div = document.createElement('div');
      div.style.cssText = 'position:fixed;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px;z-index:2147483647;pointer-events:none;background:linear-gradient(120deg,transparent 30%,rgba(139,92,246,0.3) 50%,transparent 70%);background-size:200% 100%;animation:wt-shimmer 0.5s ease-out forwards;border:1.5px solid rgba(139,92,246,0.6);border-radius:3px;box-shadow:0 0 8px rgba(139,92,246,0.25);';
      (document.getElementById('Weavetab-root')?.shadowRoot || document.getElementById('Weavetab-root') || document.body).appendChild(div);
      setTimeout(function(){ if(div.parentNode) div.parentNode.removeChild(div); }, 600);
      return true;
    })()`;
  }

  async function trySelector(sel: string): Promise<boolean> {
    const r = await session.Runtime.evaluate({ expression: makeSelectorShimmer(sel), returnByValue: true })
      .catch(() => ({ result: { value: false } }));
    return !!(r as any)?.result?.value;
  }

  // Use CDP DOM.getBoxModel to get coordinates for a backendNodeId — no DOM query needed
  async function tryNodeHighlight(bnId: number): Promise<boolean> {
    try {
      const { nodeIds } = await session.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [bnId] });
      if (!nodeIds?.[0]) return false;
      const box = await session.DOM.getBoxModel({ nodeId: nodeIds[0] }).catch(() => null);
      if (!box?.model?.content) return false;
      const q = box.model.content;
      const x = q[0]!, y = q[1]!, w = q[2]! - q[0]!, h = q[5]! - q[1]!;
      if (w <= 0 || h <= 0) return false;
      const r = await session.Runtime.evaluate({ expression: makeCoordShimmer(x, y, w, h), returnByValue: true });
      return !!(r as any)?.result?.value;
    } catch { return false; }
  }

  // ── Resolve params ─────────────────────────────────────────────────────────
  let resolvedSelector = selector;
  let numericId: number | null = null;

  if (!resolvedSelector) {
    const refId = options.id || options.ref || options.target;
    if (refId) {
      const stripped = refId.replace(/^w:/, '');
      numericId = parseInt(stripped, 10);
      resolvedSelector = `[data-wt-id="${stripped}"]`;
    } else if (options.label) {
      resolvedSelector = `[aria-label="${options.label.replace(/"/g, '\\"')}"]`;
    }
  }

  // Strategy 1: CSS selector query
  if (resolvedSelector && await trySelector(resolvedSelector)) {
    return { success: true, message: `Highlighted ${resolvedSelector}` };
  }

  // Strategy 2: Extension oracle coords (__Weavetab_getCoords)
  if (resolvedSelector) {
    const coordsRes = await session.Runtime.evaluate({
      expression: `(window.__Weavetab_getCoords || window.__Weavetab_getCoords || function(){return null;})(${JSON.stringify(resolvedSelector)})`,
      returnByValue: true,
    }).catch(() => null);
    const cv = (coordsRes as any)?.result?.value;
    if (cv?.raw) {
      const { left, top, w, h } = cv.raw;
      const r = await session.Runtime.evaluate({ expression: makeCoordShimmer(left, top, w, h), returnByValue: true });
      if ((r as any)?.result?.value) return { success: true, message: `Highlighted ${resolvedSelector} via coords` };
    }
  }

  // Strategy 3: CDP DOM by backendNodeId (for explicit nodeId param)
  if (nodeId && await tryNodeHighlight(nodeId)) {
    return { success: true, message: `Highlighted backendNodeId ${nodeId}` };
  }

  // Strategy 4: Walk action map cache to find the backendNodeId for a w:NN ref
  if (numericId !== null) {
    try {
      const { getCachedActionMap } = await import('../state/cache.js');
      const { sessionRegistry } = await import('../state/session.js');
      const activeClient = sessionRegistry.getActive(getConfigAgentId(_config));
      const targetId = activeClient?.targetId || 'default';
      const cachedMap = activeClient?.url ? getCachedActionMap(targetId, activeClient.url) : null;
      if (cachedMap?.elements) {
        const el = (cachedMap.elements as any[]).find(e => {
          const n = parseInt(String(e.id).replace(/^w:/, ''), 10);
          return n === numericId;
        });
        if (el?.selector && await trySelector(el.selector)) {
          return { success: true, message: `Highlighted w:${numericId} via cache selector` };
        }
        if (el?.backendNodeId && await tryNodeHighlight(el.backendNodeId)) {
          return { success: true, message: `Highlighted w:${numericId} via action map backendNodeId` };
        }
        // Strategy 5: coordinate fallback from cached element position
        if (el?.x !== undefined && el?.y !== undefined) {
          const ew = el.width ?? 80, eh = el.height ?? 24;
          const r = await session.Runtime.evaluate({
            expression: makeCoordShimmer(el.x - ew / 2, el.y - eh / 2, ew, eh),
            returnByValue: true,
          });
          if ((r as any)?.result?.value) return { success: true, message: `Highlighted w:${numericId} via cache coords` };
        }
      }
    } catch { /* no cache */ }
  }

  return { success: false, message: `Could not find element to highlight` };
}
