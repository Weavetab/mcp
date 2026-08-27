import { logDebug } from "../audit/logger.js";
/**
 * src/overlay/injector.ts
 * Weavetab — Browser Presence Layer v3 (stripped)
 *
 * Kept:     SPA nav detection,
 *           __wt_setConfig, __wt_status, favicon state.
 * Removed:  cursor (moved to content.js), chat panel, thought bubble,
 *           ask modal, screen glow, CSS keyframes, emoji system.
 *
 * @module overlay/injector
 */

import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getConfigDevMode } from "../config/loader.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export type CursorState =
  | "idle" | "hover" | "clicking" | "typing" | "thinking"
  | "searching" | "reading" | "navigating"
  | "scrolling" | "dragging" | "burst" | "waiting"
  | "github" | "stuck" | "eval" | "clear";

// ─── Minimal Overlay Script ───────────────────────────────────────────────────

export function getMinimalOverlayScript(): string {
  return `(function(){
  'use strict';

  // ── Persistent shadow container ────────────────────────────────────────────
  var __wt_sr = null;
  function ec() {
    if (__wt_sr && __wt_sr.host && __wt_sr.host.isConnected) return __wt_sr;
    var h = document.getElementById('Weavetab-root');
    if (h && h.shadowRoot) { __wt_sr = h.shadowRoot; return __wt_sr; }
    if (!h) {
      var root = document.body || document.head || document.documentElement;
      if (root) {
        h = document.createElement('weavetab-host');
        h.id = 'Weavetab-root';
        h.setAttribute('data-wt-ignore', '');
        h.style.cssText = 'all:initial !important;position:fixed !important;left:0 !important;top:0 !important;width:0 !important;height:0 !important;z-index:2147483647 !important;pointer-events:none !important;touch-action:none !important;background:transparent !important;opacity:1 !important;transform:none !important;filter:none !important;';
        root.appendChild(h);
      } else {
        return null;
      }
    }
    __wt_sr = h.shadowRoot || h.attachShadow({ mode: 'open' });
    return __wt_sr;
  }

  // ── Install ─────────────────────────────────────────────────────────────────
  window.__wt_install_minimal = function() {
    var s = ec();
    if (!s) return false;
    var $ = function(id) { return s.getElementById(id) || document.getElementById(id); };

    // Cleanup old UI elements (pre-overlay-rewrite)
    var oldEls = ['wt-chat-icon','wt-chat-tooltip','wt-shadow-host','Weavetab-tactical-overlay','wt-ghost-cursor','wt-ghost-bubble','wt-ask-panel','wt-cur-canvas'];
    for (var oi = 0; oi < oldEls.length; oi++) { var oe = document.getElementById(oldEls[oi]); if (oe) oe.remove(); }

    // SPA navigation
    if (!window.__wt_nav_installed) {
      window.__wt_nav_installed = true;
      var em = function(type, url) {
        window.__wt_nav_event = { type: type, url: url, ts: Date.now() };
        document.dispatchEvent(new CustomEvent('__wt_navigation', { detail: { type: type, url: url } }));
      };
      var ps = history.pushState.bind(history);
      var rs = history.replaceState.bind(history);
      history.pushState = function() { ps.apply(history, arguments); em('pushState', arguments.length > 2 ? arguments[2] : null); };
      history.replaceState = function() { rs.apply(history, arguments); em('replaceState', arguments.length > 2 ? arguments[2] : null); };
      window.addEventListener('popstate', function() { em('popstate', location.href); });
      document.addEventListener('NavigationEnd', function() { em('angular', location.href); });
    }

    // The message listeners below are guarded so they are registered exactly once
    // per page, even when __wt_install_minimal() is called repeatedly (e.g. SPAs
    // with frequent navigations).
    if (!window.__wt_msg_installed) {
      window.__wt_msg_installed = true;
      window.__wt_chat_queue = window.__wt_chat_queue || [];
      window.addEventListener("message", function(e) {
        if (e.data && e.data.type === "__WT_FEEDBACK") {
          window.__wt_chat_queue.push(e.data.text);
        }
      });
    }

    window.__wt_setConfig = function(c) {
      if (c && c.devMode) window.__wt_devMode = true;
    };

    window.__wt_status = function() { return JSON.stringify({ rootInjected: true }); };

    // ── Fallback relay (works w/out extension) ───────────────────────
    // Cursor + HUD handled by content.js (extension). This is a no-op relay.
    window.__wt_fallback_handle = function(e) {
      if (window.__Weavetab && window.__Weavetab.version) return;
    };
    window.addEventListener('Weavetab-msg-in', window.__wt_fallback_handle);

    return true;
  };

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', window.__wt_install_minimal);
    } else {
      window.__wt_install_minimal();
    }
  } catch(e) { logDebug('[Weavetab] Overlay init error:', e?.message || e); }
})();`;
}

// ─── Script reinstall expression ─────────────────────────────────────────────

export const INSTALL_EXPR =
  `if(window.__wt_install_minimal)window.__wt_install_minimal();`;

// ─── CDP helpers ──────────────────────────────────────────────────────────────

async function evalInPage(session: CDP.Client, expression: string): Promise<boolean> {
  try {
    const result = await session.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    if (result?.exceptionDetails) {
      const ed = result.exceptionDetails;
      logDebug("[Weavetab] Overlay eval error:", ed.text, ed.lineNumber ? `line ${ed.lineNumber}` : '', ed.columnNumber ? `col ${ed.columnNumber}` : '', ed.exception?.description || ed.exception?.value || '');
      if (ed.exception?.description?.includes('TypeError') || ed.exception?.description?.includes('ReferenceError')) {
        logDebug("[Weavetab] Full exception:", ed.exception.description);
      }
      return false;
    }
    return true;
  } catch (e: unknown) {
    logDebug("[Weavetab] Overlay eval failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

function buildConfigExpr(config: Config): string {
  const msg = { type: 'Weavetab_CONFIG', devMode: getConfigDevMode(config) };
  return `
if(window.__wt_setConfig)window.__wt_setConfig(${JSON.stringify({
    ...config,
  })});
window.postMessage({type:'Weavetab-msg-in',data:${JSON.stringify(msg)}},'*');
`;
}

// ─── Public surface ───────────────────────────────────────────────────────────

export async function ensureVisualLayer(
  session: CDP.Client,
  config: Config,
  client?: import("../cdp/connector.js").BrowserClient
): Promise<void> {
  try {
    // CSP Bypass removed for security reasons

    const minimal = getMinimalOverlayScript();

    if (!client?.overlayScriptId) {
      try {
        const reg = await session.Page.addScriptToEvaluateOnNewDocument({ source: minimal });
        if (client && reg?.identifier) {
          client.overlayScriptId = reg.identifier;
          logDebug(`[Weavetab] [OK] Overlay script registered with ID: ${reg.identifier}`);
        }
      } catch (regErr) {
        logDebug(`[Weavetab] [!] Failed to register overlay script: ${regErr}`);
      }
    }

    await evalInPage(session, minimal);

    await evalInPage(session, buildConfigExpr(config));

    if (client) client.overlayInstalled = true;
    
    // Verify overlay was actually injected
    try {
      const { result: checkResult } = await session.Runtime.evaluate({
        expression: `!!document.getElementById('Weavetab-root')`,
        returnByValue: true
      });
      if (checkResult?.value) {
        logDebug(`[Weavetab] [OK] Minimal overlay injected successfully`);
      } else {
        logDebug(`[Weavetab] [!] Minimal overlay injection failed - element not found`);
      }
    } catch (checkErr) {
      logDebug(`[Weavetab] [!] Could not verify overlay injection: ${checkErr}`);
    }
  } catch (overlayErr) {
    logDebug(`[Weavetab] [!] ensureVisualLayer failed: ${overlayErr}`);
    throw overlayErr;
  }
}

export async function setupOverlay(
  session: CDP.Client,
  config: Config
): Promise<void> {
  await ensureVisualLayer(session, config);
}

export async function setFaviconState(
  _session: CDP.Client,
  _state: CursorState
): Promise<void> {
  // Handled robustly via extension content.js
}

export async function removeTitleBadge(_session: CDP.Client): Promise<void> {
  // No-op: title dot prefix removed in favor of favicon indicators
}

export async function hideCursor(session: CDP.Client): Promise<void> {
  // Cursor lives in content.js — handled via Weavetab_STATE messages
}

export async function setCursorState(
  session: CDP.Client,
  state: CursorState
): Promise<void> {
  await setFaviconState(session, state);
}
