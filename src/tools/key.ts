/**
 * Weavetab — tools/key.ts
 * Keyboard event dispatcher with allowlisted control keys and modifier support.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import { recordAction } from "../intelligence/trail.js";
import { waitForDOMStable } from "../sensors/guard.js";
import { waitForNetworkIdle } from "../sensors/wait.js";
import { buildActionMap, toRefEntries } from "../cdp/walker.js";
import { cacheActionMap, cacheBoxModel } from "../state/cache.js";
import { computeDelta, storeSnapshot } from "../state/delta.js";
import { sessionRegistry } from "../state/session.js";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";
import type { WeaveError } from "./click.js";
import { sendToExtension } from "../cdp/helpers.js";

type Modifier = "Alt" | "Ctrl" | "Meta" | "Shift";

const ALLOWED_KEYS = new Set([
  "Enter", "Escape", "Tab", "Backspace", "Delete", "Space",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "Home", "End", "PageUp", "PageDown",
  "F1","F2","F3","F4","F5","F6","F7","F8","F9","F10","F11","F12",
]);

interface KeyResult {
  success: true;
  pressed: string;
  tab_id: string;
  url: string;
  title: string;
  url_changed?: boolean;
  dom_changed?: boolean;
  stuck_warning?: boolean;
  stuck_hint?: string;
}

export async function weaveKey(
  session: CDP.Client,
  args: { key: string; modifiers?: Modifier[] },
  _config: Config
): Promise<KeyResult | WeaveError> {
  const { key, modifiers } = args;

  // Allow single printable chars or control keys from the allowlist
  if (key.length > 1 && !ALLOWED_KEYS.has(key)) {
    return {
      success: false,
      error_code: "INVALID_KEY",
      message: `[!] Key "${key}" is not a valid control key. Use single characters or: ${[...ALLOWED_KEYS].join(", ")}`,
    };
  }

  let modMask = 0;
  if (modifiers) {
    if (modifiers.includes("Alt"))   modMask |= 1;
    if (modifiers.includes("Ctrl"))  modMask |= 2;
    if (modifiers.includes("Meta"))  modMask |= 4;
    if (modifiers.includes("Shift")) modMask |= 8;
  }

  const label = modifiers && modifiers.length > 0 ? `${modifiers.join("+")}+${key}` : key;
  await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `pressing ${label}` } });

  const { frameTree: beforeFrameTree } = await session.Page.getFrameTree();
  const urlBefore = beforeFrameTree.frame.url;

  // Track map before for delta if Enter is pressed
  let targetId = "default";
  const active = sessionRegistry.getActive(getConfigAgentId(_config));
  if (active) targetId = active.targetId;
  const mapBefore = await buildActionMap(session, { lite: true }, targetId);
  storeSnapshot(targetId, urlBefore, toRefEntries(mapBefore.elements));

  // We removed the direct toast injection here because the extension handles HUD display via Weavetab_STATE (line 66)

  await session.Input.dispatchKeyEvent({ type: "rawKeyDown", key, modifiers: modMask, windowsVirtualKeyCode: key === "Enter" ? 13 : undefined, nativeVirtualKeyCode: key === "Enter" ? 13 : undefined });
  if (key === "Enter") {
    // SPA Fallback: direct form submit + submit button click for React/Vue/Google
    // This is needed because Input.dispatchKeyEvent alone doesn't trigger SPA form submission
    await session.Runtime.evaluate({ expression: `
      (function(){
        try {
          var el = document.activeElement;
          if (!el || !el.tagName) return;

          // Focus the element first to make sure it's active
          if (typeof el.focus === 'function') el.focus();

          // 1. Try native form submit (Google search, DuckDuckGo, etc.)
          var form = el.closest('form');
          if (form) {
            var submitBtn = form.querySelector('input[type="submit"], button[type="submit"]');
            if (submitBtn && submitBtn.offsetParent !== null) { submitBtn.click(); return; }
            try { form.submit(); return; } catch(e) {}
          }

          // 2. Google-specific: find name="q" input and submit its form
          var q = document.querySelector('input[name="q"], textarea[name="q"]');
          if (q) {
            var qForm = q.closest('form');
            if (qForm) { try { qForm.submit(); return; } catch(e) {} }
          }

          // 3. Last resort: find any visible submit/search button near the active element
          var parent = el.parentElement;
          while (parent && parent.tagName !== 'BODY') {
            var btns = parent.querySelectorAll('button, input[type="submit"], input[type="button"]');
            for (var i = 0; i < btns.length; i++) {
              if (btns[i].offsetParent !== null && btns[i].getBoundingClientRect().width > 0) { btns[i].click(); return; }
            }
            parent = parent.parentElement;
          }
        } catch(e) {}
      })();
    `}).catch(() => {});
  }
  await session.Input.dispatchKeyEvent({ type: "keyUp", key, modifiers: modMask, windowsVirtualKeyCode: key === "Enter" ? 13 : undefined, nativeVirtualKeyCode: key === "Enter" ? 13 : undefined });

  // ── Post-Action Pipeline & Predictive Action Queue ────────────────────────

  const predictiveQueue = async () => {
    try {
      const nextMap = await buildActionMap(session, { lite: true }, targetId);
      cacheActionMap(targetId, nextMap);
      
      for (const el of nextMap.elements.slice(0, 10)) {
        if (el.backendNodeId) {
          const { nodeIds } = await session.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [el.backendNodeId] }).catch(() => ({ nodeIds: [] }));
          if (nodeIds[0]) {
            const box = await session.DOM.getBoxModel({ nodeId: nodeIds[0] }).catch(() => null);
            if (box) cacheBoxModel(targetId, el.backendNodeId, box.model);
          }
        }
      }
    } catch { /* ignore pre-fetch errors */ }
  };

  const settleTimeout = key === "Enter" ? 5000 : 2500;
  await Promise.all([
    waitForDOMStable(session, 50, settleTimeout),
    waitForNetworkIdle(session, 50, settleTimeout).catch(() => {}),
    predictiveQueue()
  ]);

  // Post-key location context
  let postUrl = "";
  let postTitle = "";
  try {
    const { frameTree } = await session.Page.getFrameTree();
    postUrl = frameTree.frame.url;
    try {
      const titleRes = await session.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
      postTitle = (titleRes?.result?.value as string) || postUrl;
    } catch { postTitle = postUrl; }
    const activeSession = sessionRegistry.getActive(getConfigAgentId(_config));
    if (activeSession) { activeSession.url = postUrl; activeSession.title = postTitle; }
  } catch { /* ignore */ }

  const urlChanged = postUrl !== urlBefore;
  let domChanged = false;
  let stuckWarning = false;
  let stuckHint: string | undefined;

  if (key === "Enter") {
    const nextMap = await buildActionMap(session, { lite: true }, targetId);
    const newRefs = toRefEntries(nextMap.elements);
    const diff = computeDelta(targetId, urlBefore, newRefs);
    const changedRefs = diff ? [...diff.added, ...diff.changed] : [];
    domChanged = changedRefs.length > 0 || (diff?.removed.length ?? 0) > 0;
    stuckWarning = !domChanged && !urlChanged;
    if (stuckWarning) {
      await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: 'hmm, no response. reassessing...' } });
      stuckHint = "Page did not respond to Enter key. You might need to find the actual submit button and use browser_click instead.";
    }
  }

  recordAction({
    timestamp: new Date().toISOString(),
    tool: "browser_key",
    input: { key, modifiers },
    result: { success: true, pressed: label },
  });

  return { 
    success: true, 
    pressed: label, 
    tab_id: targetId, 
    url: postUrl, 
    title: postTitle,
    url_changed: urlChanged,
    dom_changed: domChanged,
    stuck_warning: stuckWarning,
    ...(stuckHint ? { stuck_hint: stuckHint } : {})
  };
}
