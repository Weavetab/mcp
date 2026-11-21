/**
 * Weavetab — tools/navigate.ts
 * URL navigation with domain blocklist enforcement and post-navigation DOM stability wait.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import { checkDomain } from "../security/blacklist.js";
import { logAction, logDebug } from "../audit/logger.js";
import { awaitNavigation } from "../sensors/guard.js";
import { clearSnapshot } from "../state/delta.js";
import { resetLoopCounter, clearToolCallWindow } from "../intelligence/trail.js";
import { resetFallbackIdCounter, clearShadowDomCache, clearAXTreeCache } from "../cdp/walker.js";
import { clearTabCache } from "../state/cache.js";
import { bumpVisitCount } from "../intelligence/sessionMemory.js";

import { sessionRegistry } from "../state/session.js";
import type { Config } from "../config/loader.js";
import type { WeaveError } from "./click.js";

interface NavigateResult {
  success: true;
  url: string;
  title: string;
  tab_id: string;
}

export async function weaveNavigate(
  session: CDP.Client,
  url: string,
  config: Config,
  targetId = "default",
  _force = false,
  fast = false,
  appName?: string
): Promise<NavigateResult | WeaveError> {
  logDebug(`[weaveNavigate] Attempting navigation to: ${url}`);
  let parsed: URL;
  if (url.toLowerCase().startsWith('weavetab://')) {
    const page = url.slice('weavetab://'.length).split('?')[0] || 'dashboard';
    try {
      const { getFromExtension } = await import("../cdp/helpers.js");
      const extUrl = await getFromExtension(session, { type: 'RESOLVE_EXTENSION_URL', page });
      if (extUrl) {
        parsed = new URL(extUrl);
      } else {
        return { success: false, error_code: "EXTENSION_URL_FAILED", message: `Could not resolve weavetab://${page}` };
      }
    } catch {
      return { success: false, error_code: "EXTENSION_NOT_AVAILABLE", message: "Extension runtime not available for weavetab:// navigation" };
    }
  } else {
    try {
      parsed = new URL(url);
    } catch {
      logDebug(`[weaveNavigate] Invalid URL: ${url}`);
      return { success: false, error_code: "INVALID_URL", message: `[!] Invalid URL: ${url}` };
    }
  }

  const active = sessionRegistry.getActive(config.agentId, appName);
  const isElectron = !!(appName || active?.isElectron);

  // Allowed web and desktop application protocols.
  // Block script-execution protocols (javascript:, data:) that bypass safety policies.
  const proto = parsed.protocol.toLowerCase();
  const allowedProtocols = new Set([
    "http:",
    "https:",
    "file:",
    "chrome-extension:",
    "app:",
    "vscode-webview:",
    "vscode-file:",
    "discord:",
    "slack:",
    "devtools:",
    "chrome:",
    "about:",
  ]);

  if (!allowedProtocols.has(proto)) {
    return { success: false, error_code: "BLOCKED_PROTOCOL", message: `[!] Blocked protocol '${proto}'. Only web, file, and desktop app protocols are allowed.` };
  }

  // Domain policy check only applies to standard web navigations
  if (!isElectron && (proto === "http:" || proto === "https:")) {
    const domainCheck = checkDomain(parsed.href, config);
    logDebug(`[weaveNavigate] Domain check for ${parsed.hostname}: ${JSON.stringify(domainCheck)}`);
    if (!domainCheck.allowed) {
      return { success: false, error_code: "DOMAIN_BLOCKED", message: `[!] Weave blocked: ${domainCheck.reason}` };
    }
  }


  // Extension pages: open in new tab instead of navigating current tab
  // (chrome-extension:// pages use a different process context — Page.navigate
  //  can break the CDP session or not fire loadEventFired properly)
  if (parsed.protocol === 'chrome-extension:') {
    logDebug(`[weaveNavigate] Extension URL detected — opening in new tab: ${parsed.href}`);
    const { sendToExtension } = await import("../cdp/helpers.js");
    await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `opening extension page...` } });
    const { WeavetabOpen } = await import("./tabs.js");
    const openRes = await WeavetabOpen(parsed.href, config, true);
    // Ensure overlay is installed on new tab
    try {
      const { ensureVisualLayer } = await import("../overlay/injector.js");
      const newClient = sessionRegistry.getAll().find(c => c.targetId === openRes.tabId);
      if (newClient) {
        for (let i = 0; i < 10; i++) {
          newClient.overlayInstalled = false;
          await ensureVisualLayer(newClient.session, config, newClient);
          const status = await newClient.session.Runtime.evaluate({
            expression: `!!document.getElementById('wt-chat-icon')`,
            returnByValue: true
          }).catch(() => ({ result: { value: false } }));
          if (status?.result?.value === true) break;
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } catch { /* overlay install is best-effort */ }
    logAction("browser_navigate", url, `opened extension tab ${openRes.tabId}`);
    return {
      success: true,
      url: openRes.url,
      title: 'Weavetab Dashboard',
      tab_id: openRes.tabId
    };
  }

  // Resolve active tab id
  const resolvedTargetId = active?.targetId ?? targetId;

  const { sendToExtension } = await import("../cdp/helpers.js");
  sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `navigating to ${parsed.hostname}...` } }).catch(() => {});
  sendToExtension(session, { type: 'Weavetab_STATE', cursor: { x: 10, y: 10 }, state: 'thinking' }).catch(() => {});

  await session.Page.navigate({ url: parsed.href });
  session.Page.bringToFront().catch(() => {});

  // Fast navigation wait
  try {
    await awaitNavigation(session, config.navigationTimeout || 30000);
  } catch (navErr) {
    logDebug(`[weaveNavigate] Navigation timeout: ${navErr}`);
  }

  // Clear delta snapshot & caches
  clearSnapshot(resolvedTargetId);
  resetLoopCounter("navigation");
  clearToolCallWindow();
  resetFallbackIdCounter();
  clearShadowDomCache(resolvedTargetId);
  clearAXTreeCache(resolvedTargetId);
  clearTabCache(resolvedTargetId);

  // Parallelize post-navigation metadata & cookie banner dismissal (web only, never Electron)
  const shouldDismissCookie = !isElectron && (proto === "http:" || proto === "https:");
  const [frameRes, titleRes] = await Promise.all([
    session.Page.getFrameTree().catch(() => ({ frameTree: { frame: { url: parsed.href } } })),
    session.Runtime.evaluate({ expression: 'document.title', returnByValue: true }).catch(() => null),
    shouldDismissCookie
      ? session.Runtime.evaluate({
          expression: `
            (function(){
              var selectors = [
                '[id*="cookie"] button','[class*="cookie"] button',
                '[id*="consent"] button','[class*="consent"] button',
                '[id*="gdpr"] button','[class*="gdpr"] button',
                '[aria-label*="Accept"]','[aria-label*="Agree"]',
                'button[data-cookiebanner]'
              ];
              for(var i=0;i<selectors.length;i++){
                var el=document.querySelector(selectors[i]);
                if(el){try{el.click();}catch(e){}break;}
              }
            })()
          `
        }).catch(() => {})
      : Promise.resolve(),
  ]);

  const finalUrl = frameRes?.frameTree?.frame?.url || parsed.href;
  const title = (titleRes?.result?.value as string) || parsed.hostname || parsed.pathname || finalUrl;

  // Keep session registry in sync with the new URL
  if (active) active.url = finalUrl;

  sendToExtension(session, { type: 'Weavetab_STATE', cursor: { x: 10, y: 10 }, state: 'idle', hud: { action: '' } }).catch(() => {});

  logAction("browser_navigate", url, `arrived at ${title}`);

  // Bump the visit counter for this domain exactly once per navigation
  bumpVisitCount(parsed.hostname).catch(() => {});

  return { success: true, url: finalUrl, title, tab_id: resolvedTargetId };
}
