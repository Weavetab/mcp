/**
 * Weavetab — tools/highlight.ts
 * browser_highlight: draws visual consideration, target lock, danger/success or shimmer overlays.
 * Supports multiple candidate refs, custom styles, floating labels, and multi-tier fallbacks.
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";

export type HighlightStyle = "consideration" | "target" | "danger" | "success" | "shimmer";

export interface HighlightOptions {
  selector?: string;
  id?: string;
  ref?: string;
  refs?: string[];
  target?: string;
  label?: string;
  nodeId?: number;
  color?: string;
  style?: HighlightStyle;
  duration?: number;
}

export async function browserHighlight(
  session: CDP.Client,
  options: HighlightOptions,
  _config: Config
): Promise<{ success: boolean; message: string }> {
  const style = options.style || (options.refs && options.refs.length > 0 ? "consideration" : "shimmer");
  const defaultDuration = style === "shimmer" ? 600 : 2000;
  const duration = typeof options.duration === "number" && options.duration > 0 ? options.duration : defaultDuration;
  const customLabel = options.label || "";
  const customColor = options.color;

  // Inject required keyframes once
  await session.Runtime.evaluate({
    expression: `(function(){
      if (!document.getElementById('wt-highlight-styles')) {
        var s = document.createElement('style');
        s.id = 'wt-highlight-styles';
        s.textContent = \`
          @keyframes wt-shimmer {
            0% { opacity: 0; background-position: -200% 0; }
            15% { opacity: 0.9; }
            40% { opacity: 0.7; }
            85% { opacity: 0.3; }
            100% { opacity: 0; background-position: 200% 0; }
          }
          @keyframes wt-consider-pulse {
            0%, 100% { box-shadow: 0 0 0 1px rgba(56,189,248,0.7), 0 0 14px rgba(56,189,248,0.35); opacity: 0.92; }
            50% { box-shadow: 0 0 0 2px rgba(56,189,248,0.95), 0 0 22px rgba(56,189,248,0.6); opacity: 1; }
          }
          @keyframes wt-target-lock {
            0% { transform: scale(1.05); opacity: 0.5; }
            100% { transform: scale(1); opacity: 1; }
          }
          @keyframes wt-danger-pulse {
            0%, 100% { box-shadow: 0 0 0 1px rgba(239,68,68,0.7), 0 0 14px rgba(239,68,68,0.35); opacity: 0.92; }
            50% { box-shadow: 0 0 0 2px rgba(239,68,68,0.95), 0 0 22px rgba(239,68,68,0.6); opacity: 1; }
          }
          @keyframes wt-success-glow {
            0% { opacity: 0.6; box-shadow: 0 0 0 1px rgba(16,185,129,0.7); }
            100% { opacity: 1; box-shadow: 0 0 0 2px rgba(16,185,129,0.9), 0 0 18px rgba(16,185,129,0.45); }
          }
        \`;
        (document.head || document.documentElement).appendChild(s);
      }
    })()`,
    returnByValue: true,
  }).catch(() => {});

  function getOverlayCss(styleName: HighlightStyle, durMs: number, colorOverride?: string): string {
    if (colorOverride) {
      return `border:2px solid ${colorOverride};box-shadow:0 0 14px ${colorOverride};background:${colorOverride}1a;border-radius:4px;transition:opacity 0.2s ease-out;`;
    }
    switch (styleName) {
      case "consideration":
        return `border:1.5px solid rgba(56,189,248,0.9);background:rgba(56,189,248,0.08);box-shadow:0 0 14px rgba(56,189,248,0.4);border-radius:4px;animation:wt-consider-pulse 1.4s ease-in-out infinite;`;
      case "target":
        return `border:2px solid rgba(245,158,11,0.95);background:rgba(245,158,11,0.12);box-shadow:0 0 16px rgba(245,158,11,0.45);border-radius:4px;animation:wt-target-lock 0.2s cubic-bezier(0.16,1,0.3,1);`;
      case "danger":
        return `border:1.5px solid rgba(239,68,68,0.95);background:rgba(239,68,68,0.1);box-shadow:0 0 16px rgba(239,68,68,0.45);border-radius:4px;animation:wt-danger-pulse 1.4s ease-in-out infinite;`;
      case "success":
        return `border:1.5px solid rgba(16,185,129,0.95);background:rgba(16,185,129,0.1);box-shadow:0 0 16px rgba(16,185,129,0.45);border-radius:4px;animation:wt-success-glow 0.3s ease-out forwards;`;
      case "shimmer":
      default:
        return `background:linear-gradient(120deg,transparent 30%,rgba(139,92,246,0.3) 50%,transparent 70%);background-size:200% 100%;animation:wt-shimmer ${durMs / 1000}s ease-out forwards;border:1.5px solid rgba(139,92,246,0.6);border-radius:3px;box-shadow:0 0 8px rgba(139,92,246,0.25);`;
    }
  }

  // Draw overlay at raw coordinates
  function makeCoordOverlay(x: number, y: number, w: number, h: number, badgeLabel?: string): string {
    const styleCss = getOverlayCss(style, duration, customColor);
    const escapedBadge = badgeLabel ? badgeLabel.replace(/"/g, '&quot;') : '';
    const badgeHtml = escapedBadge
      ? `<span style="position:absolute;top:-20px;left:0;background:#09090b;border:1px solid #27272a;color:#f4f4f5;font-size:10px;font-family:-apple-system,BlinkMacSystemFont,\\'Segoe UI\\',sans-serif;font-weight:500;padding:1px 6px;border-radius:4px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,0.5);">${escapedBadge}</span>`
      : '';

    return `(function(){
      var div = document.createElement('div');
      div.setAttribute('data-wt-ignore', 'true');
      div.style.cssText = 'position:fixed;left:${x}px;top:${y}px;width:${w}px;height:${h}px;z-index:2147483647;pointer-events:none;${styleCss}';
      if (${JSON.stringify(badgeHtml)}) {
        div.innerHTML = ${JSON.stringify(badgeHtml)};
      }
      (document.getElementById('Weavetab-root')?.shadowRoot || document.getElementById('Weavetab-root') || document.body).appendChild(div);
      setTimeout(function(){
        div.style.transition = 'opacity 0.2s ease-out';
        div.style.opacity = '0';
        setTimeout(function(){ if(div.parentNode) div.parentNode.removeChild(div); }, 220);
      }, ${duration});
      return true;
    })()`;
  }

  // Draw overlay by querying selector
  function makeSelectorOverlay(sel: string, badgeLabel?: string): string {
    const escaped = sel.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const styleCss = getOverlayCss(style, duration, customColor);
    const escapedBadge = badgeLabel ? badgeLabel.replace(/"/g, '&quot;') : '';
    const badgeHtml = escapedBadge
      ? `<span style="position:absolute;top:-20px;left:0;background:#09090b;border:1px solid #27272a;color:#f4f4f5;font-size:10px;font-family:-apple-system,BlinkMacSystemFont,\\'Segoe UI\\',sans-serif;font-weight:500;padding:1px 6px;border-radius:4px;white-space:nowrap;pointer-events:none;box-shadow:0 2px 6px rgba(0,0,0,0.5);">${escapedBadge}</span>`
      : '';

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
      div.setAttribute('data-wt-ignore', 'true');
      div.style.cssText = 'position:fixed;left:'+r.left+'px;top:'+r.top+'px;width:'+r.width+'px;height:'+r.height+'px;z-index:2147483647;pointer-events:none;${styleCss}';
      if (${JSON.stringify(badgeHtml)}) {
        div.innerHTML = ${JSON.stringify(badgeHtml)};
      }
      (document.getElementById('Weavetab-root')?.shadowRoot || document.getElementById('Weavetab-root') || document.body).appendChild(div);
      setTimeout(function(){
        div.style.transition = 'opacity 0.2s ease-out';
        div.style.opacity = '0';
        setTimeout(function(){ if(div.parentNode) div.parentNode.removeChild(div); }, 220);
      }, ${duration});
      return true;
    })()`;
  }

  async function trySelector(sel: string, badgeLabel?: string): Promise<boolean> {
    const r = await session.Runtime.evaluate({ expression: makeSelectorOverlay(sel, badgeLabel), returnByValue: true })
      .catch(() => ({ result: { value: false } }));
    return !!(r as any)?.result?.value;
  }

  async function tryNodeHighlight(bnId: number, badgeLabel?: string): Promise<boolean> {
    try {
      const { nodeIds } = await session.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [bnId] });
      if (!nodeIds?.[0]) return false;
      const box = await session.DOM.getBoxModel({ nodeId: nodeIds[0] }).catch(() => null);
      if (!box?.model?.content) return false;
      const q = box.model.content;
      const x = q[0]!, y = q[1]!, w = q[2]! - q[0]!, h = q[5]! - q[1]!;
      if (w <= 0 || h <= 0) return false;
      const r = await session.Runtime.evaluate({ expression: makeCoordOverlay(x, y, w, h, badgeLabel), returnByValue: true });
      return !!(r as any)?.result?.value;
    } catch { return false; }
  }

  async function highlightSingleTarget(targetIdentifier: string, badge?: string): Promise<boolean> {
    let sel = targetIdentifier;
    let numericId: number | null = null;

    if (targetIdentifier.startsWith("w:")) {
      const stripped = targetIdentifier.slice(2);
      numericId = parseInt(stripped, 10);
      sel = `[data-wt-id="${stripped}"]`;
    }

    if (await trySelector(sel, badge)) return true;

    // Extension oracle coords fallback
    const coordsRes = await session.Runtime.evaluate({
      expression: `(window.__Weavetab_getCoords || function(){return null;})(${JSON.stringify(sel)})`,
      returnByValue: true,
    }).catch(() => null);
    const cv = (coordsRes as any)?.result?.value;
    if (cv?.raw) {
      const { left, top, w, h } = cv.raw;
      const r = await session.Runtime.evaluate({ expression: makeCoordOverlay(left, top, w, h, badge), returnByValue: true });
      if ((r as any)?.result?.value) return true;
    }

    // Action map cache fallback
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
          if (el?.selector && await trySelector(el.selector, badge)) return true;
          if (el?.backendNodeId && await tryNodeHighlight(el.backendNodeId, badge)) return true;
          if (el?.x !== undefined && el?.y !== undefined) {
            const ew = el.width ?? 80, eh = el.height ?? 24;
            const r = await session.Runtime.evaluate({
              expression: makeCoordOverlay(el.x - ew / 2, el.y - eh / 2, ew, eh, badge),
              returnByValue: true,
            });
            if ((r as any)?.result?.value) return true;
          }
        }
      } catch { /* ignore */ }
    }
    return false;
  }

  // ── Multi-ref consideration overlay ───────────────────────────────────────
  if (options.refs && Array.isArray(options.refs) && options.refs.length > 0) {
    let successCount = 0;
    for (let i = 0; i < options.refs.length; i++) {
      const refItem = options.refs[i]!;
      const itemBadge = customLabel ? (options.refs.length > 1 ? `${customLabel} [${i + 1}]` : customLabel) : refItem;
      const ok = await highlightSingleTarget(refItem, itemBadge);
      if (ok) successCount++;
    }
    return {
      success: successCount > 0,
      message: `Highlighted ${successCount}/${options.refs.length} element(s) with style '${style}' (${duration}ms)`
    };
  }

  // ── Single target resolution ──────────────────────────────────────────────
  if (options.nodeId && await tryNodeHighlight(options.nodeId, customLabel)) {
    return { success: true, message: `Highlighted backendNodeId ${options.nodeId} with style '${style}'` };
  }

  let singleRef = options.selector || options.id || options.ref || options.target;
  if (!singleRef && options.label) {
    singleRef = `[aria-label="${options.label.replace(/"/g, '\\"')}"]`;
  }

  if (singleRef) {
    const badgeText = customLabel || (singleRef.startsWith("w:") ? singleRef : undefined);
    const ok = await highlightSingleTarget(singleRef, badgeText);
    if (ok) {
      return { success: true, message: `Highlighted ${singleRef} with style '${style}' (${duration}ms)` };
    }
  }

  return { success: false, message: `Could not find element to highlight` };
}
