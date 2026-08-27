import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — cdp/connector.ts
 * CDP connection pool, browser launch, per-tab session wiring.
 * V3: Two-factor lock validation, networkIdle with 5s fallback, SIGTERM cleanup.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { blockStorageAccess } from "../security/guard.js";
import { launchWithBridge, launchElectronApp, injectStealthScript } from "./bridge.js";
import { setupOverlay, ensureVisualLayer, INSTALL_EXPR } from "../overlay/injector.js";
import { onConfigChange, saveConfig, loadConfigSync, getCachedConfig, getConfigAgentId, getConfigCookies, getConfigProfileDir, getConfigMode, getConfigBrowserType, getConfigRole, getElectronAppConfig, getConfigExtension } from "../config/loader.js";
import { clearSnapshot } from "../state/delta.js";
import { sessionRegistry } from "../state/session.js";
import { initConsoleBuffering } from "../tools/console.js";
import { registerMutationListener, clearTabCache } from "../state/cache.js";
import { recordTabActivity } from "../tools/tabs.js";
import { initDialogHandler } from "../tools/dialog.js";
import { clearViewportCache, WT_REGISTRY_INIT_EXPR } from "./walker.js";
import { urcInvalidate } from "./ref_cache.js";
import { readLock, clearLock, isLockValid, isLockPending, acquireMutex } from "./lock.js";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import { getSessionProfile, getElectronProfile } from "./profiles.js";
import { safelyKillWeavetabProcesses, verifyProfileIsolation, verifyBrowserFingerprint, clearProfileVerificationCache } from "./security.js";

function withCDPTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

onConfigChange((newConfig) => {
  const activeClient = sessionRegistry.getActive(getConfigAgentId(newConfig));
  if (activeClient) {
    activeClient.session.Runtime.evaluate({
      expression: `if(window.__wt_setConfig) window.__wt_setConfig(${JSON.stringify(newConfig)}); else window.__wt_config = ${JSON.stringify(newConfig)};`
    }).catch(() => {});
  }
});

let actualPort: number | null = null;
let activeEngine: import("../config/loader.js").BrowserEngine = "chromium";

/** Per-tab analytics interval handles — keyed by targetId.
 *  Replacing the old single-slot global that caused interval leaks when multiple tabs were open. */
const analyticsIntervals = new Map<string, ReturnType<typeof setInterval>>();

export function getPort(): number | null {
  return actualPort;
}

export function getActiveEngine(): import("../config/loader.js").BrowserEngine {
  return activeEngine;
}

export interface BrowserClient {
  session: CDP.Client;
  targetId: string;
  url: string;
  title: string;
  overlayScriptId?: string;
  overlayInstalled: boolean;
  agentId: string;
  browserContextId?: string;
  appName?: string;
  isElectron?: boolean;
  /** Sticky pruning state: if true, all subsequent DOM reads by action tools (click, type, etc.) will also apply pruning. */
  pruneActive?: boolean;
}

// ─── Navigation readiness: loadEventFired + networkIdle with 5s cap ───────────

async function waitForPageReady(session: CDP.Client): Promise<void> {
  const NETWORK_IDLE_TIMEOUT_MS = 5000;
  const NETWORK_IDLE_QUIET_MS = 500;

  const readyCheck = await session.Runtime.evaluate({
    expression: "document.readyState === 'complete'",
    returnByValue: true
  }).catch(() => ({ result: { value: false } }));

  if (readyCheck?.result?.value !== true) {
    await Promise.race([
      session.Page.loadEventFired(),
      new Promise<void>(r => setTimeout(r, 10000)), // max 10s for load
    ]);
  }

  // networkIdle: no new requests for NETWORK_IDLE_QUIET_MS, capped at NETWORK_IDLE_TIMEOUT_MS
  await new Promise<void>((resolve) => {
    let done = false;
    let quietTimer: NodeJS.Timeout | null = null;
    const hardTimeout = setTimeout(() => { done = true; resolve(); }, NETWORK_IDLE_TIMEOUT_MS);

    const cleanup = () => {
      if (done) return;
      done = true;
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(hardTimeout);
      try {
        (session as any).removeListener("Network.requestWillBeSent", resetQuiet);
        (session as any).removeListener("Network.loadingFinished", resetQuiet);
        (session as any).removeListener("Network.loadingFailed", resetQuiet);
      } catch { /* ignore */ }
      resolve();
    };

    const resetQuiet = () => {
      if (done) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(cleanup, NETWORK_IDLE_QUIET_MS);
    };

    // Listen for network activity
    session.Network.enable().catch(() => {});
    session.Network.on("requestWillBeSent", resetQuiet);
    session.Network.on("loadingFinished", resetQuiet);
    session.Network.on("loadingFailed", resetQuiet);
    resetQuiet(); // start the quiet timer immediately
  });
}

// ─── Session init (overlay + re-injection) ───────────────────────────────────

async function initSession(session: CDP.Client, targetId: string, port: number, config: Config, isElectron?: boolean): Promise<void> {
  initDialogHandler(session);

  // Initialize Omni-Context Broker for iframes
  const { initOmniBroker } = await import("./omni_broker.js");
  await initOmniBroker(session, targetId, port);

  if (isElectron) {
    // Electron desktop app initialization
    try {
      await session.Page.addScriptToEvaluateOnNewDocument({ source: WT_REGISTRY_INIT_EXPR });
    } catch { /* non-fatal */ }

    // Direct DOM minimal overlay injection without Chrome Extension
    await ensureVisualLayer(session, config);
  } else if (activeEngine === "chromium") {
    // Only block cookies/storage when cookies mode is disabled
    if (!getConfigCookies(config)) {
      await blockStorageAccess(session);
    }

    // Inject stealth script before page runs anything
    await injectStealthScript(session);

    // Inject WeakMap registry so atomicResolve can re-hydrate elements after SPA reconciliation
    try {
      await session.Page.addScriptToEvaluateOnNewDocument({ source: WT_REGISTRY_INIT_EXPR });
    } catch { /* non-fatal — older CDP targets may not support this */ }

    // Inject overlay (requires Chrome extension)
    await setupOverlay(session, config);

    // Force silent downloads — suppress the Windows "Save As" OS popup entirely.
    // Weavetab routes all downloads to the active .weavetab/downloads directory.
    try {
      const { getOutputDir, getDownloadDir } = await import("../config/loader.js");
      const fs = await import("node:fs");
      const downloadDir = getDownloadDir(config)?.trim()
        ? getDownloadDir(config).trim()
        : getOutputDir("downloads", config);
      if (!fs.default.existsSync(downloadDir)) {
        fs.default.mkdirSync(downloadDir, { recursive: true });
      }
      await (session as any).Browser.setDownloadBehavior({
        behavior: "allow",
        downloadPath: downloadDir,
        eventsEnabled: true,
      }).catch(() => {});
    } catch { /* non-fatal: older Chrome versions may not support this API */ }
  }

  registerMutationListener(session, targetId);
  initConsoleBuffering(session, targetId);

  // Re-inject on navigation — use loadEventFired instead of raw setTimeout
  session.Page.on("frameNavigated", async (frame) => {
    if (frame.frame.parentId) return;
    clearTabCache(targetId);
    // Invalidate URC on navigation — elements from the old page are stale
    urcInvalidate(targetId);
    if (isElectron || activeEngine === "chromium") {
      try {
        await waitForPageReady(session);
        const cfg = getCachedConfig();
        const clientRef = sessionRegistry.getAll().find(c => c.targetId === targetId);
        if (clientRef) clientRef.overlayInstalled = false;
        await ensureVisualLayer(session, cfg, clientRef ?? undefined);
      } catch { /* ignore */ }
    }
  });

  // Diagnostic: verify extension content script loaded (Standard browser only)
  if (!isElectron && activeEngine === "chromium" && getConfigExtension(config) !== false) {
    try {
      // Check for multiple indicators that extension is loaded
      const { result: extCheck } = await session.Runtime.evaluate({
        expression: `!!(
          document.querySelector('weavetab-host') ||
          document.getElementById('__Weavetab_cursor_host') || 
          document.getElementById('wt-ui-styles') ||
          document.querySelector('[data-wt-internal]') ||
          window.__wt_chat_queue
        )`,
        returnByValue: true,
      });
      
      if (extCheck?.value) {
        logDebug(`[Weavetab] [OK] Extension content script detected`);
      } else {
        logDebug(`[Weavetab] [!] Extension content script NOT detected — HUD/overlay may not work`);
        logDebug(`[Weavetab] [!] Try reloading page or check if extension loaded in browser://extensions`);
      }
    } catch (checkErr) {
      logDebug(`[Weavetab] [!] Extension health check failed: ${checkErr}`);
    }

    // Push config + initial idle state to extension right away (Chrome only)
    const { sendToExtension } = await import("../cdp/helpers.js");
    sendToExtension(session, {
      type: 'Weavetab_CONFIG',
      devMode: config.devMode,
    }).catch(() => {});
    sendToExtension(session, {
      type: 'Weavetab_GROUP_STATE',
      state: 'idle',
    }).catch(() => {});
  }

  // Analytics ping every 30s
  const sessionStartTime = Date.now();
  const analyticsInterval = setInterval(async () => {
    try {
      const t = Date.now();
      const healthObj = await session.Runtime.evaluate({
        expression: `document.readyState === 'complete' ? '100% Loaded' : 'Loading...'`,
        returnByValue: true
      });
      const latency = Date.now() - t;
      const health = healthObj?.result?.value || "Unknown";
      const sessionSeconds = Math.floor((Date.now() - sessionStartTime) / 1000);
      await session.Runtime.evaluate({
        expression: `if(window.__wt_push_analytics) window.__wt_push_analytics("${health}", ${latency}, ${sessionSeconds})`
      }).catch(() => {});
    } catch { /* ignore */ }
  }, 30_000);
  analyticsIntervals.set(targetId, analyticsInterval);
  analyticsInterval.unref();
}

// ─── Main connection entry point ──────────────────────────────────────────────

export async function getOrConnect(config: Config, targetApp?: string): Promise<BrowserClient> {
  if (getConfigMode(config) === "attach" && !targetApp) {
    throw new Error("[!] Attach mode (connect to your real browser) coming soon. Use session mode for now.");
  }

  // 1. Check existing active session for this agent & app
  const activeClient = sessionRegistry.getActive(getConfigAgentId(config), targetApp);
  if (activeClient) {
    try {
      await activeClient.session.Browser.getVersion();
      return activeClient;
    } catch {
      logDebug(`[Weavetab CDP] Connection lost for ${targetApp || "browser"}. Reconnecting...`);
      clearProfileVerificationCache(activeClient.targetId);
      sessionRegistry.unregister(activeClient.targetId);
    }
  }

  const releaseMutex = await acquireMutex(targetApp);
  try {
    if (targetApp) {
      // ──────────────── ELECTRON APP CONNECTION FLOW ────────────────
      const appCfg = getElectronAppConfig(targetApp, config);
      if (!appCfg) {
        throw new Error(
          `[Weavetab] ✗ Electron app "${targetApp}" is not configured in config.json.\n` +
          `  Please add an entry under "electron": { "${targetApp}": "C:\\\\path\\\\to\\\\app.exe" } in your config.`
        );
      }

      let port: number | null = null;
      const sessionLock = readLock(targetApp);
      if (sessionLock && sessionLock.mode === "session") {
        if (isLockPending(sessionLock)) {
          logDebug(`[Weavetab] Launch in progress for ${targetApp} by PID ${sessionLock.pid}. Waiting up to 5s...`);
          for (let i = 0; i < 5; i++) {
            await new Promise(r => setTimeout(r, 1000));
            const updatedLock = readLock(targetApp);
            if (!updatedLock || !isLockPending(updatedLock)) break;
          }
        }
        const freshLock = readLock(targetApp);
        if (freshLock && (await isLockValid(freshLock))) {
          port = freshLock.port;
        } else {
          clearLock(targetApp);
        }
      }

      let targets: any[] = [];
      if (port) {
        try {
          targets = await withCDPTimeout(CDP.List({ host: "127.0.0.1", port }), 3000, "CDP.List existing Electron");
        } catch {
          port = null;
        }
      }

      if (!port || targets.length === 0) {
        logDebug(`[Weavetab CDP] Launching Electron app ${targetApp}...`);
        const launchResult = await launchElectronApp(targetApp, config);
        port = launchResult.port;

        // Poll for target window availability (Electron may take up to 2-3s to render initial window)
        for (let retry = 0; retry < 10; retry++) {
          try {
            targets = await withCDPTimeout(CDP.List({ host: "127.0.0.1", port }), 2000, "CDP.List Electron retry");
            if (targets.length > 0) break;
          } catch { /* wait */ }
          await new Promise(r => setTimeout(r, 500));
        }
      }

      let pageTarget = targets.find(t => t.type === "page" || t.type === "webview" || t.type === "app") ?? targets[0];
      if (!pageTarget) {
        throw new Error(`[Weavetab] ✗ No window or webview target found in Electron app "${targetApp}".`);
      }

      const targetId = pageTarget.id || pageTarget.targetId;
      const session = await withCDPTimeout(CDP({ host: "127.0.0.1", port, target: targetId }), 5000, "CDP connect Electron target");

      (session as any).on("close", () => {
        logDebug(`[Weavetab CDP] Electron session WebSocket closed (${targetApp}) — unregistering.`);
        const iv = analyticsIntervals.get(targetId);
        if (iv) { clearInterval(iv); analyticsIntervals.delete(targetId); }
        clearProfileVerificationCache(targetId);
        import("./omni_broker.js").then(m => m.cleanupOmniBroker(targetId)).catch(()=>{});
        import("../tools/network_intercept.js").then(m => m.cleanupNetworkIntercept(session as any)).catch(()=>{});
        sessionRegistry.unregister(targetId);
      });
      (session as any).on("error", (err: any) => {
        logDebug(`[Weavetab CDP] Electron session WebSocket error (${targetApp}):`, err?.message ?? err);
      });

      // Validate connection health
      try {
        await session.Browser.getVersion();
      } catch {
        throw new Error("Failed health check: CDP session connected to Electron app but getVersion failed.");
      }

      await Promise.all([
        session.Accessibility.enable(),
        session.DOM.enable(),
        session.Page.enable(),
        session.Runtime.enable(),
        session.Network.enable().catch(() => {}),
        session.Performance.enable().catch(() => {})
      ]);

      await wireUiConfigBinding(session);

      await initSession(session, targetId, port, config, true);

      await session.Target.setDiscoverTargets({ discover: true }).catch(() => {});

      logDebug(`[Weavetab CDP] [OK] Active Electron target: ${pageTarget.title || pageTarget.url || targetApp}`);

      const client: BrowserClient = {
        session,
        targetId,
        url: pageTarget.url || "",
        title: pageTarget.title || targetApp,
        overlayInstalled: false,
        agentId: getConfigAgentId(config),
        appName: targetApp,
        isElectron: true,
      };

      sessionRegistry.register(targetId, client);
      return client;
    }

    // ──────────────── STANDARD WEB BROWSER FLOW ────────────────
    const sessionLock = readLock();

    if (sessionLock && sessionLock.mode === "session") {
      if (isLockPending(sessionLock)) {
        logDebug(`[Weavetab] Launch in progress by PID ${sessionLock.pid}. Waiting up to 5s...`);
        for (let i = 0; i < 5; i++) {
          await new Promise(r => setTimeout(r, 1000));
          const updatedLock = readLock();
          if (!updatedLock || !isLockPending(updatedLock)) {
            break;
          }
        }
      }

      const freshLock = readLock();
      if (freshLock) {
        const valid = await isLockValid(freshLock);
        if (valid) {
          actualPort = freshLock.port;
        } else {
          logDebug("[Weavetab CDP] Stale lock detected — clearing.");
          clearLock();
          actualPort = null;
        }
      } else {
        actualPort = null;
      }
    } else if (sessionLock) {
      actualPort = null;
    }

    let port = actualPort ?? null;
    let targets: CDP.Target[];

    try {
      if (!port) throw new Error("no port yet");
      targets = await withCDPTimeout(CDP.List({ host: "127.0.0.1", port }), 5000, "CDP.List existing");
      actualPort = port;
    } catch {
      logDebug(`[Weavetab CDP] No browser on port ${port ?? "auto"}. Launching new instance...`);
      // Only kill stale Weavetab processes — never kill the PID belonging to a
      // still-valid lock. Two server processes sharing a profile would otherwise kill
      // each other's browser on every reconnect.
      const profileDir = getSessionProfile(getConfigCookies(config), getConfigProfileDir(config));
      try {
        const currentLock = readLock();
        if (currentLock && await isLockValid(currentLock)) {
          logDebug(`[Weavetab Security] Skipping safelyKill — current lock PID ${currentLock.pid} is still valid.`);
        } else {
          safelyKillWeavetabProcesses(profileDir);
        }
      } catch { /* ignore */ }

      const launchResult = await launchWithBridge(config);
      port = launchResult.port;
      activeEngine = launchResult.engine ?? "chromium";
      actualPort = port;
      targets = await withCDPTimeout(CDP.List({ host: "127.0.0.1", port }), 5000, "CDP.List new");
    }

    // Pick best target
    const metaSession = await withCDPTimeout(CDP({ host: "127.0.0.1", port }), 5000, "CDP metaSession");
    let bctxId = sessionRegistry.getBrowserContextIdForAgent(getConfigAgentId(config));

    if (!bctxId) {
      // When cookies:true, use the default browser context so profile cookies,
      // sessions, and extensions are accessible. Only create an isolated incognito
      // context when cookies are disabled (privacy/sandbox mode).
      const cookiesEnabled = getConfigCookies(config);
      if (cookiesEnabled) {
        // Use default context — cookies from profile are available
        bctxId = undefined as any;
      } else {
        try {
          const res = await metaSession.Target.createBrowserContext({ disposeOnDetach: false });
          bctxId = res.browserContextId;
          sessionRegistry.setBrowserContextIdForAgent(getConfigAgentId(config), bctxId);
        } catch (e) {
          logDebug("[Weavetab CDP] Context creation failed (might not be supported by this browser), falling back to default context.", e);
        }
      }
    }

    const { targetInfos } = await metaSession.Target.getTargets();
    let agentTargets = targetInfos.filter(t => t.type === "page" && (!bctxId || t.browserContextId === bctxId));
    
    let pageTarget = agentTargets.find(t => t.url !== "about:blank" && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://")) ?? agentTargets.find(t => !t.url.startsWith("chrome-extension://")) ?? agentTargets[0];

    if (!pageTarget || pageTarget.url === "about:blank") {
      const { targetId } = await metaSession.Target.createTarget({ url: "chrome://newtab/", browserContextId: bctxId });
      // Keep the stale about:blank ref so we can close it below
      const staleId = pageTarget?.targetId;
      pageTarget = { targetId, url: "chrome://newtab/", title: "New Tab", type: "page" } as any;
      // If we replaced an about:blank, close it now
      if (staleId) {
        await metaSession.Target.closeTarget({ targetId: staleId }).catch(() => {});
      }
    }

    // Close stale about:blank tabs to avoid visual clutter on each launch
    try {
      const blankTabs = agentTargets.filter(t => t.url === "about:blank" && t.targetId !== pageTarget!.targetId);
      for (const bt of blankTabs) {
        await metaSession.Target.closeTarget({ targetId: bt.targetId }).catch(() => {});
      }
    } catch { /* non-fatal */ }

    await metaSession.close();

    if (!pageTarget) throw new Error("No active page tab found even after launching.");

    const session = await withCDPTimeout(CDP({ host: "127.0.0.1", port, target: pageTarget.targetId }), 5000, "CDP connect target");

    // Auto-cleanup on CDP WebSocket close/error (browser crash, tab close, etc.)
    (session as any).on("close", () => {
      logDebug("[Weavetab CDP] Session WebSocket closed — unregistering.");
      // Cancel this tab's analytics interval so it doesn't run after disconnect
      const tid = pageTarget!.targetId;
      const iv = analyticsIntervals.get(tid);
      if (iv) { clearInterval(iv); analyticsIntervals.delete(tid); }
      clearProfileVerificationCache(tid);
      import("./omni_broker.js").then(m => m.cleanupOmniBroker(tid)).catch(()=>{});
      import("../tools/network_intercept.js").then(m => m.cleanupNetworkIntercept(session as any)).catch(()=>{});
      sessionRegistry.unregister(tid);
    });
    (session as any).on("error", (err: any) => {
      logDebug("[Weavetab CDP] Session WebSocket error:", err?.message ?? err);
    });

    // Validate connection health
    try {
      await session.Browser.getVersion();
    } catch {
      throw new Error("Failed health check: CDP session connected but getVersion failed.");
    }

    await Promise.all([
      session.Accessibility.enable(),
      session.DOM.enable(),
      session.Page.enable(),
      session.Runtime.enable(),
      session.Network.enable().catch(() => {}),
      session.Performance.enable().catch(() => {})
    ]);

    await wireUiConfigBinding(session);
    
    // Verify browser fingerprint at connect time
    const fingerprintLock = readLock();
    if (fingerprintLock && fingerprintLock.fingerprint) {
      const fingerprintCheck = await verifyBrowserFingerprint(session, {
        pid: fingerprintLock.pid || 0,
        port: fingerprintLock.port,
        profileDir: fingerprintLock.profileDir,
        browserPath: fingerprintLock.browserPath,
        launchTimestamp: fingerprintLock.fingerprint.launchTimestamp,
        userAgent: fingerprintLock.fingerprint.userAgent || "",
        cdpVersion: fingerprintLock.fingerprint.cdpVersion || "",
      });
      if (!fingerprintCheck.valid) {
        logDebug(`[Weavetab Security] Browser fingerprint verification failed: ${fingerprintCheck.reason}`);
        // Continue anyway for now - in production this should be a hard failure
      } else {
        logDebug(`[Weavetab Security] Browser fingerprint verified successfully`);
      }
    }
    
    // NOTE: initSession() already installs the frameNavigated handler (overlay
    // re-injection + clearSnapshot + clearViewportCache). Do NOT add a second
    // one here — it would fire twice on every navigation, doubling CDP load.
    await initSession(session, pageTarget.targetId, port, config);
    
    // Verify profile isolation at session init time (cached, no per-call overhead)
    const profileCheck = await verifyProfileIsolation(session, config, pageTarget.targetId);
    if (!profileCheck.verified) {
      logDebug(`[Weavetab Security] Profile isolation verification failed - using unexpected profile`);
      logDebug(`[Weavetab Security] Expected: ${profileCheck.expectedProfile}`);
      logDebug(`[Weavetab Security] Actual: ${profileCheck.actualProfile || 'unknown'}`);
      // Continue anyway for now - in production this should be a hard failure
    } else {
      logDebug(`[Weavetab Security] Profile isolation verified successfully`);
    }

    await session.Target.setDiscoverTargets({ discover: true });

    session.on("Target.targetActivated", (event: any) => {
      const activatedId = event?.targetInfo?.targetId ?? event?.targetId;
      if (activatedId) {
        const client = sessionRegistry.getAll().find(c => c.targetId === activatedId);
        if (client) {
          sessionRegistry.setActive(activatedId, client.agentId, client.appName);
        }
      }
    });

    session.Target.on("targetCreated", async (event) => {
      if (event.targetInfo.type === "page") {
        sessionRegistry.notifyNewTab(event.targetInfo.targetId);
        recordTabActivity(event.targetInfo.targetId);
        try {
          const bctxId = (event.targetInfo as any).browserContextId;
          const agentIdForTab = bctxId ? sessionRegistry.getAgentForBrowserContextId(bctxId) : undefined;
          await connectToTab(event.targetInfo.targetId, port!, agentIdForTab, bctxId);
          // Auto-connect to new tab
        } catch (e) {
          logDebug(`[Weavetab] Failed to auto-connect to new tab: ${e}`);
        }
      }
    });

    session.Target.on("targetDestroyed", (event) => {
      clearProfileVerificationCache(event.targetId);
      sessionRegistry.unregister(event.targetId);
    });

    session.Target.on("targetInfoChanged", (event) => {
      const changedId = event.targetInfo.targetId;
      recordTabActivity(changedId);
      const match = sessionRegistry.getAll().find(c => c.targetId === changedId);
      if (match) {
        match.url = event.targetInfo.url;
        match.title = event.targetInfo.title;
      }
    });

    logDebug(`[Weavetab CDP] [OK] Active tab: ${pageTarget.title || pageTarget.url}`);

    const client: BrowserClient = {
      session,
      targetId: pageTarget.targetId,
      url: pageTarget.url,
      title: pageTarget.title,
      overlayInstalled: false,
      agentId: getConfigAgentId(config),
      browserContextId: bctxId,
    };

    sessionRegistry.register(pageTarget.targetId, client);

    // Wire overlay into all other open tabs for this agent
    const otherPages = agentTargets.filter(t => t.targetId !== pageTarget!.targetId);
    for (const t of otherPages) {
      connectToTab(t.targetId, port, getConfigAgentId(config), bctxId).catch(() => {});
    }

    return client;
  } finally {
    await releaseMutex();
  }
}

export async function getTabList(agentId?: string, targetApp?: string): Promise<any[]> {
  const config = getCachedConfig();

  let port: number | null = null;
  if (targetApp) {
    const lock = readLock(targetApp);
    if (lock && (await isLockValid(lock))) {
      port = lock.port;
    }
  } else {
    port = actualPort;
    if (!port) {
      const lock = readLock();
      if (lock && lock.mode === "session") {
        const valid = await isLockValid(lock);
        if (valid) {
          port = lock.port;
        } else {
          logDebug("[Weavetab CDP] getTabList: stale lock detected — clearing.");
          clearLock();
          port = null;
        }
      }
    }
  }
  if (!port) throw new Error(`[!] No active ${targetApp ? targetApp : "browser"} session. Run browser_go or launch app first.`);

  try {
    const metaSession = await withCDPTimeout(CDP({ host: "127.0.0.1", port }), 5000, "getTabList CDP");
    const { targetInfos } = await withCDPTimeout(metaSession.Target.getTargets(), 5000, "getTabList getTargets");
    await metaSession.close();

    const aid = agentId || getConfigAgentId(config);
    const bctxId = sessionRegistry.getBrowserContextIdForAgent(aid);

    return targetInfos
      .filter(t => (t.type === "page" || t.type === "webview" || t.type === "app" || t.type === "other" || t.type === "iframe") && (!bctxId || t.browserContextId === bctxId))
      .map(t => ({
        id: t.targetId,
        title: t.title || t.url || t.type,
        url: t.url,
        type: t.type,
      }));
  } catch {
    throw new Error(`[!] Weavetab cannot reach ${targetApp ? targetApp : "browser"} on port ${port}.`);
  }
}

// Only allow the UI to update cosmetic/dev settings via the binding.
// Never allow overwriting security-critical fields (role, browserPath, block, allow, profileDir, etc.).
const UI_ALLOWED_FIELDS = new Set(["devMode", "extension"]);

async function wireUiConfigBinding(session: CDP.Client): Promise<void> {
  try {
    await session.Runtime.addBinding({ name: "__wt_save_ui_config" });
    session.Runtime.on("bindingCalled", (event) => {
      if (event.name === "__wt_save_ui_config") {
        try {
          const payload = JSON.parse(event.payload);
          if (typeof payload !== "object" || payload === null) return;
          const currentConfig = loadConfigSync();
          const safe: Record<string, unknown> = {};
          for (const k of Object.keys(payload)) {
            if (UI_ALLOWED_FIELDS.has(k)) safe[k] = payload[k];
          }
          if (Object.keys(safe).length === 0) return;
          saveConfig({ ...currentConfig, ...safe });
        } catch (e) {
          logDebug("[Weavetab] Error saving config from UI:", e);
        }
      }
    });
  } catch { /* already bound */ }
}

export async function connectToTab(targetId: string, port?: number, agentId?: string, browserContextId?: string, appName?: string): Promise<BrowserClient> {
  const existing = sessionRegistry.getAll().find(c => c.targetId === targetId);
  if (existing) return existing;

  const lock = readLock(appName);
  const p = port || (appName ? lock?.port : (actualPort || lock?.port));
  if (!p) throw new Error(`[!] No active ${appName || "browser"} session. Run browser_go first.`);

  let t: any = null;
  try {
    const targets = await withCDPTimeout(CDP.List({ host: "127.0.0.1", port: p }), 3000, "connectToTab CDP.List");
    t = targets.find((item: any) => (item.id || item.targetId) === targetId);
  } catch {}
  if (!t) {
    try {
      const metaSession = await withCDPTimeout(CDP({ host: "127.0.0.1", port: p }), 3000, "connectToTab meta CDP");
      const { targetInfos } = await withCDPTimeout(metaSession.Target.getTargets(), 3000, "connectToTab meta getTargets");
      await metaSession.close();
      const ti = targetInfos.find(item => item.targetId === targetId);
      if (ti) {
        t = { id: ti.targetId, targetId: ti.targetId, url: ti.url, title: ti.title, type: ti.type };
      }
    } catch {}
  }
  if (!t) {
    t = { id: targetId, targetId, url: "", title: appName || "Tab", type: "page" };
  }

  const session = await withCDPTimeout(CDP({ host: "127.0.0.1", port: p, target: targetId }), 5000, "connectToTab CDP");

  (session as any).on("close", () => {
    logDebug(`[Weavetab CDP] connectToTab session closed (${appName || "browser"}) — unregistering.`);
    // Cancel this tab's analytics interval so it doesn't outlive the session
    const iv = analyticsIntervals.get(targetId);
    if (iv) { clearInterval(iv); analyticsIntervals.delete(targetId); }
    clearProfileVerificationCache(targetId);
    import("./omni_broker.js").then(m => m.cleanupOmniBroker(targetId)).catch(()=>{});
    import("../tools/network_intercept.js").then(m => m.cleanupNetworkIntercept(session as any)).catch(()=>{});
    sessionRegistry.unregister(targetId);
  });
  (session as any).on("error", (err: any) => {
    logDebug(`[Weavetab CDP] connectToTab session error (${appName || "browser"}):`, err?.message ?? err);
  });

  await Promise.all([
    session.Accessibility.enable(),
    session.DOM.enable(),
    session.Page.enable(),
    session.Runtime.enable(),
    session.Network.enable().catch(() => {}),
    session.Performance.enable().catch(() => {})
  ]);

  await wireUiConfigBinding(session);

  const currentConfig = getCachedConfig();
  await initSession(session, targetId, p, currentConfig, !!appName);

  // NOTE: initSession() already installs a frameNavigated handler that handles
  // clearSnapshot, clearViewportCache, and ensureVisualLayer. Do NOT add a second
  // one here — it would double the CDP work on every navigation.

  const actualAgentId = agentId || getConfigAgentId(currentConfig);

  const client: BrowserClient = {
    session,
    targetId,
    url: t.url,
    title: t.title,
    overlayInstalled: false,
    agentId: actualAgentId,
    browserContextId,
    appName,
    isElectron: !!appName,
  };

  sessionRegistry.register(targetId, client);
  return client;
}

// ─── Cleanup: called on process exit/signal ───────────────────────────────────

/**
 * Cancel analytics intervals and close the CDP WebSocket sessions without
 * touching the browser process. Safe to call in server mode — the browser
 * remains alive for the next client.
 */
export async function cleanupIntervals(): Promise<void> {
  // Cancel every per-tab analytics interval.
  for (const iv of analyticsIntervals.values()) clearInterval(iv);
  analyticsIntervals.clear();

  // Close CDP WebSocket connections so the Node process can exit cleanly,
  // but do NOT send Browser.close() — that would kill the browser process.
  const clients = sessionRegistry.getAll();
  for (const client of clients) {
    try { await client.session.close(); } catch { /* ignore */ }
  }
}

/**
 * Full cleanup: intervals + WebSocket sessions + Browser.close().
 * Only safe to call when the browser should also be terminated (non-server mode,
 * SIGINT, SIGTERM, explicit user-requested shutdown).
 */
export async function cleanupAll(): Promise<void> {
  const clients = sessionRegistry.getAll();

  // Try to cleanly shut down the browser using the first available CDP session.
  if (clients.length > 0) {
    try {
      await clients[0].session.Browser.close();
    } catch { /* ignore */ }
  }

  // Cancel intervals and close WebSocket sessions.
  await cleanupIntervals();
}
