/**
 * Weavetab — tools/canvas.ts
 * browser_canvas: Extract canvas image data as base64 or dispatch raw stroke/drawing events.
 * Supports ref resolution via action map cache and CDP DOM APIs.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";
import { ghostClick } from "../overlay/ghost.js";

export interface CanvasOptions {
  action: "get_image" | "draw";
  selector?: string;
  id?: string;
  label?: string;
  ref?: string;
  backendNodeId?: number;
  points?: { x: number; y: number }[]; // For "draw" action (relative to canvas top-left)
}

interface CanvasRect {
  x: number;
  y: number;
  dataUrl: string;
}

async function resolveCanvasBackendNodeId(
  session: CDP.Client,
  options: CanvasOptions,
  _config: Config
): Promise<number | undefined> {
  if (options.backendNodeId) return options.backendNodeId;

  const refId = options.ref || options.id;
  if (!refId) return undefined;

  try {
    const { getCachedActionMap } = await import("../state/cache.js");
    const { sessionRegistry } = await import("../state/session.js");
    const activeClient = sessionRegistry.getActive(getConfigAgentId(_config));
    const targetId = activeClient?.targetId || "default";
    const cachedMap = activeClient?.url ? getCachedActionMap(targetId, activeClient.url) : null;
    if (cachedMap?.elements) {
      const numericId = parseInt(refId.replace(/^w:/, ""), 10);
      const el = (cachedMap.elements as any[]).find((e: any) => {
        const n = parseInt(String(e.id).replace(/^w:/, ""), 10);
        return n === numericId;
      });
      if (el?.backendNodeId) return el.backendNodeId;
    }
  } catch { /* cache miss — fall through */ }

  return undefined;
}

async function resolveCanvasViaCDP(
  session: CDP.Client,
  backendNodeId: number
): Promise<CanvasRect> {
  const { nodeIds } = await session.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [backendNodeId] });
  if (!nodeIds?.[0]) throw new Error("Canvas backendNodeId could not be resolved");

  const { object } = await session.DOM.resolveNode({ nodeId: nodeIds[0] });
  if (!object?.objectId) throw new Error("Could not resolve canvas node to object");

  const { result } = await session.Runtime.callFunctionOn({
    objectId: object.objectId,
    functionDeclaration: `function() {
      var rect = this.getBoundingClientRect();
      return JSON.stringify({
        x: rect.left,
        y: rect.top,
        dataUrl: this.toDataURL('image/png')
      });
    }()`,
    returnByValue: true,
  });

  return JSON.parse(result.value as string);
}

async function resolveCanvasViaSelector(
  session: CDP.Client,
  options: CanvasOptions,
  targetId: string
): Promise<CanvasRect> {
  let selector: string;
  if (options.selector) {
    selector = options.selector;
  } else if (options.id) {
    selector = `[data-wt-id="${options.id.replace(/^w:/, "")}"]`;
  } else if (options.label) {
    selector = `canvas[aria-label="${options.label.replace(/"/g, '\\"')}"], canvas[title="${options.label.replace(/"/g, '\\"')}"]`;
  } else if (options.ref) {
    selector = `[data-wt-id="${options.ref.replace(/^w:/, "")}"]`;
  } else {
    selector = "canvas";
  }

  const { omniEvaluate } = await import("../cdp/omni_broker.js");
  const raw = await omniEvaluate(session, targetId, `(function() {
      let el;
      try { el = document.querySelector(${JSON.stringify(selector)}); } catch(e) { el = null; }
      // Skip extension overlay canvases
      if (el && (el.closest('[data-wt-overlay]') || el.closest('.weavetab-overlay') || el.id === '__wt_ghost_canvas')) {
        var total = document.querySelectorAll('canvas').length;
        return JSON.stringify({ error: 'Selector matched a WeaveTab overlay canvas (hidden). Found ' + total + ' <canvas> element(s) on page — try a more specific selector or use nodeId.', exists: false });
      }
      if (!el) {
        var total = document.querySelectorAll('canvas').length;
        if (total === 0) return JSON.stringify({ error: 'No <canvas> elements found on this page.', exists: false });
        return JSON.stringify({ error: 'Selector did not match any element. Found ' + total + ' <canvas> element(s) on page — try a more specific selector or use nodeId.', exists: false });
      }
      if (el.tagName !== 'CANVAS') return JSON.stringify({ error: 'Element is not a <canvas> — found <' + el.tagName.toLowerCase() + '> instead.', exists: false });
      var r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left, y: r.top, dataUrl: el.toDataURL('image/png'), exists: true });
    })()`);

  const parsed = JSON.parse(raw || "{}");
  if (parsed.error) throw new Error(parsed.error);
  return parsed;
}

export async function browserCanvas(
  session: CDP.Client,
  options: CanvasOptions,
  _config: Config
): Promise<{ success: boolean; dataUrl?: string; message: string }> {
  const { action, points } = options;

  const backendNodeId = await resolveCanvasBackendNodeId(session, options, _config);

  const { sessionRegistry } = await import("../state/session.js");
  const activeClient = sessionRegistry.getActive(getConfigAgentId(_config));
  const targetId = activeClient?.targetId || "default";

  let rect: CanvasRect;
  if (backendNodeId) {
    try {
      rect = await resolveCanvasViaCDP(session, backendNodeId);
    } catch {
      rect = await resolveCanvasViaSelector(session, options, targetId);
    }
  } else {
    rect = await resolveCanvasViaSelector(session, options, targetId);
  }

  if (action === "get_image") {
    return { success: true, dataUrl: rect.dataUrl, message: `Canvas extracted` };
  } else if (action === "draw") {
    if (!points || points.length === 0) {
      throw new Error("draw action requires an array of points");
    }

    const { Input } = session;
    const { x: offsetX, y: offsetY } = rect;

    const startX = offsetX + points[0].x;
    const startY = offsetY + points[0].y;

    await Input.dispatchMouseEvent({ type: "mouseMoved", x: startX, y: startY });
    await ghostClick(session, startX, startY);

    for (let i = 1; i < points.length; i++) {
      const ptX = offsetX + points[i].x;
      const ptY = offsetY + points[i].y;
      await Input.dispatchMouseEvent({ type: "mouseMoved", x: ptX, y: ptY, button: "left" });
      await new Promise(r => setTimeout(r, 10));
    }

    const lastX = offsetX + points[points.length - 1].x;
    const lastY = offsetY + points[points.length - 1].y;
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: lastX, y: lastY, button: "left", clickCount: 1 });

    return { success: true, message: `Drew ${points.length} points on canvas` };
  }

  throw new Error("Unknown action");
}
