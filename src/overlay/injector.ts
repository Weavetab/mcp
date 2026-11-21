import { logDebug } from "../audit/logger.js";
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getConfigDevMode, getConfigHeadless } from "../config/loader.js";

export type CursorState =
  | "idle" | "hover" | "clicking" | "typing" | "thinking"
  | "searching" | "reading" | "navigating"
  | "scrolling" | "dragging" | "burst" | "waiting"
  | "github" | "stuck" | "eval" | "clear";

const registeredSessions = new WeakSet<object>();

export function getMinimalOverlayScript(): string {
  return `(function(){
  'use strict';

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

  window.__wt_install_minimal = function() {
    var s = ec();
    if (!s) return false;

    var oldEls = ['wt-chat-icon','wt-chat-tooltip','wt-shadow-host','Weavetab-tactical-overlay','wt-ghost-cursor','wt-ghost-bubble','wt-ask-panel','wt-cur-canvas'];
    for (var oi = 0; oi < oldEls.length; oi++) { var oe = document.getElementById(oldEls[oi]); if (oe) oe.remove(); }

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

    window.__wt_setConfig = function(c) {
      if (c) window.__wt_devMode = !!c.devMode;
    };

    window.__wt_status = function() { return JSON.stringify({ rootInjected: true }); };

    return true;
  };

  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', window.__wt_install_minimal);
    } else {
      window.__wt_install_minimal();
    }
  } catch(e) {}
})();`;
}

export const INSTALL_EXPR =
  `if(window.__wt_install_minimal)window.__wt_install_minimal();`;

async function evalInPage(session: CDP.Client, expression: string): Promise<boolean> {
  try {
    const result = await session.Runtime.evaluate({
      expression,
      returnByValue: true,
      awaitPromise: false,
    });
    if (result?.exceptionDetails) {
      const ed = result.exceptionDetails;
      logDebug("[Weavetab] Overlay eval error:", ed.text, ed.lineNumber ? `line ${ed.lineNumber}` : "", ed.columnNumber ? `col ${ed.columnNumber}` : "", ed.exception?.description || ed.exception?.value || "");
      return false;
    }
    return true;
  } catch (e: unknown) {
    logDebug("[Weavetab] Overlay eval failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

export function buildConfigExpr(config: Config): string {
  const devMode = getConfigDevMode(config);
  const msg = { type: "Weavetab_CONFIG", devMode };
  return `
if(window.__wt_setConfig)window.__wt_setConfig(${JSON.stringify({ devMode })});
window.postMessage({type:'Weavetab-msg-in',data:${JSON.stringify(msg)}},'*');
`;
}

export async function ensureVisualLayer(
  session: CDP.Client,
  config: Config,
  client?: import("../cdp/connector.js").BrowserClient
): Promise<void> {
  if (getConfigHeadless(config)) return;

  try {
    const minimal = getMinimalOverlayScript();

    if (!client?.overlayScriptId && !registeredSessions.has(session)) {
      registeredSessions.add(session);
      try {
        const reg = await session.Page.addScriptToEvaluateOnNewDocument({ source: minimal });
        if (client && reg?.identifier) {
          client.overlayScriptId = reg.identifier;
        }
      } catch (regErr) {
        logDebug(`[Weavetab] [!] Failed to register overlay script: ${regErr}`);
      }
    }

    await evalInPage(session, minimal);
    await evalInPage(session, buildConfigExpr(config));

    if (client) client.overlayInstalled = true;
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
): Promise<void> {}

export async function removeTitleBadge(_session: CDP.Client): Promise<void> {}

export async function hideCursor(_session: CDP.Client): Promise<void> {}

export async function setCursorState(
  session: CDP.Client,
  state: CursorState
): Promise<void> {
  await setFaviconState(session, state);
}
