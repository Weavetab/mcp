import { logDebug } from "../audit/logger.js";
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { blockStorageAccess } from "../security/guard.js";
import { launchWithBridge, launchElectronApp, injectStealthScript } from "./bridge.js";
import { setupOverlay, ensureVisualLayer } from "../overlay/injector.js";
import { onConfigChange, getCachedConfig, getConfigAgentId, getConfigCookies, getConfigProfileDir, getConfigMode, getConfigDevMode, getConfigBrowserPath, getElectronAppConfig, getConfigExtension } from "../config/loader.js";
import { clearSnapshot } from "../state/delta.js";
import { sessionRegistry } from "../state/session.js";
import { initConsoleBuffering } from "../tools/console.js";
import { registerMutationListener, clearTabCache } from "../state/cache.js";
import { recordTabActivity } from "../tools/tabs.js";
import { initDialogHandler } from "../tools/dialog.js";
import { clearAXTreeCache, clearShadowDomCache } from "./walker.js";
import { labelCache } from "./label_cache.js";
import { marksInvalidate } from "../intelligence/marks.js";
import { readLock, clearLock, isLockValid, isLockPending, acquireMutex } from "./lock.js";
import { getSessionProfile } from "./profiles.js";
import { safelyKillWeavetabProcesses, verifyProfileIsolation, verifyBrowserFingerprint, clearProfileVerificationCache } from "./security.js";

function withCDPTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer!));
}

onConfigChange((newCfg) => {
  const safeUiCfg = { devMode: Boolean(getConfigDevMode(newCfg)) };
  const activeClient = sessionRegistry.getActive(getConfigAgentId(newCfg));
  if (activeClient) {
    activeClient.session.Runtime.evaluate({
      expression: `if(window.__wt_setConfig) window.__wt_setConfig(${JSON.stringify(safeUiCfg)}); else window.__wt_config = ${JSON.stringify(safeUiCfg)};`
    }).catch(() => {});
  }
});

let actualPort: number | null = null;
let activeEngine: import("../config/loader.js").BrowserEngine = "chromium";

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
  pruneActive?: boolean;
  port?: number;
}

async function waitForPageReady(session: CDP.Client): Promise<void> {
  const NETWORK_IDLE_TIMEOUT_MS = 5000;
  const NETWORK_IDLE_QUIET_MS = 500;

  const readyCheck = await session.Runtime.evaluate({
    expression: "document.readyState === 'complete'",
    returnByValue: true
  }).catch(() => ({ result: { value: false } }));

  if (readyCheck?.result?.value !== true) {
    let loadTimer: ReturnType<typeof setTimeout>;
    await Promise.race([
      session.Page.loadEventFired(),
      new Promise<void>(r => { loadTimer = setTimeout(r, 10000); }),
    ]).finally(() => clearTimeout(loadTimer!));
  }

  await new Promise<void>((resolve) => {
    let done = false;
    let quietTimer: NodeJS.Timeout | null = null;
    const unsubs: Array<() => void> = [];

    const cleanup = () => {
      if (done) return;
      done = true;
      if (quietTimer) clearTimeout(quietTimer);
      clearTimeout(hardTimeout);
      while (unsubs.length > 0) {
        const unsub = unsubs.pop();
        try { if (unsub) unsub(); } catch {}
      }
      try {
        (session as any).removeListener?.("Network.requestWillBeSent", resetQuiet);
        (session as any).removeListener?.("Network.loadingFinished", resetQuiet);
        (session as any).removeListener?.("Network.loadingFailed", resetQuiet);
      } catch { /* ignore */ }
      resolve();
    };

    const hardTimeout = setTimeout(() => { cleanup(); }, NETWORK_IDLE_TIMEOUT_MS);
    hardTimeout.unref();

    const resetQuiet = () => {
      if (done) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(cleanup, NETWORK_IDLE_QUIET_MS);
      quietTimer.unref();
    };

    session.Network.enable().catch(() => {});
    const u1 = (session.Network as any).on("requestWillBeSent", resetQuiet);
    const u2 = (session.Network as any).on("loadingFinished", resetQuiet);
    const u3 = (session.Network as any).on("loadingFailed", resetQuiet);
    if (typeof u1 === "function") unsubs.push(u1);
    if (typeof u2 === "function") unsubs.push(u2);
    if (typeof u3 === "function") unsubs.push(u3);
    resetQuiet();
  });
}

async function initSession(session: CDP.Client, targetId: string, port: number, config: Config, isElectron?: boolean): Promise<void> {
  initDialogHandler(session);

  const { initOmniBroker } = await import("./omni_broker.js");
  await initOmniBroker(session, targetId, port);
  session.Page.bringToFront().catch(() => {});

  if (isElectron) {
    await ensureVisualLayer(session, config);
  } else if (activeEngine === "chromium") {
    if (!getConfigCookies(config)) {
      await blockStorageAccess(session);
    }

    await injectStealthScript(session);

    await setupOverlay(session, config);

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
    } catch { /* non-fatal */ }
  }

  registerMutationListener(session, targetId);
  initConsoleBuffering(session, targetId);

  session.Page.on("frameNavigated", async (frame) => {
    if (frame.frame.parentId) return;
    clearTabCache(targetId);
    clearSnapshot(targetId);
    clearAXTreeCache(targetId);
    clearShadowDomCache(targetId);
    labelCache.invalidate(targetId);
    marksInvalidate(targetId);
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

  if (!isElectron && activeEngine === "chromium" && getConfigExtension(config) !== false) {
    try {
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
      }
    } catch (checkErr) {
      logDebug(`[Weavetab] [!] Extension health check failed: ${checkErr}`);
    }

    const { sendToExtension } = await import("../cdp/helpers.js");
    sendToExtension(session, {
      type: "Weavetab_CONFIG",
      devMode: config.devMode,
    }).catch(() => {});
    sendToExtension(session, {
      type: "Weavetab_GROUP_STATE",
      state: "idle",
    }).catch(() => {});
  }

  const prevIv = analyticsIntervals.get(targetId);
  if (prevIv) {
    clearInterval(prevIv);
    analyticsIntervals.delete(targetId);
  }

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

export async function getOrConnect(config: Config, targetApp?: string): Promise<BrowserClient> {
  if (getConfigMode(config) === "attach" && !targetApp) {
    const err = new Error("[!] Attach mode is not yet supported. Use session mode (default) instead.");
    (err as any).code = "NOT_IMPLEMENTED";
    throw err;
  }

  const activeClient = sessionRegistry.getActive(getConfigAgentId(config), targetApp);
  if (activeClient) {
    try {
      await activeClient.session.Browser.getVersion();
      return activeClient;
    } catch {
      logDebug(`[Weavetab CDP] Connection lost for ${targetApp || "browser"}. Reconnecting...`);
      clearProfileVerificationCache(activeClient.targetId);
      clearShadowDomCache(activeClient.targetId);
      labelCache.invalidate(activeClient.targetId);
      sessionRegistry.unregister(activeClient.targetId);
    }
  }

  const releaseMutex = await acquireMutex(targetApp);
  try {
    if (targetApp) {
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

        for (let retry = 0; retry < 10; retry++) {
          try {
            targets = await withCDPTimeout(CDP.List({ host: "127.0.0.1", port }), 2000, "CDP.List Electron retry");
            const hasMain = targets.some(t => {
              const u = (t.url || "").toLowerCase();
              const tit = (t.title || "").toLowerCase();
              return !u.includes("splash") && !tit.includes("updater") && !u.startsWith("devtools://");
            });
            if (hasMain || (retry > 4 && targets.length > 0)) break;
          } catch { /* wait */ }
          await new Promise(r => setTimeout(r, 500));
        }
      }

      const isCandidate = (t: any) => {
        const u = (t.url || "").toLowerCase();
        const tit = (t.title || "").toLowerCase();
        return !u.includes("splash") && !tit.includes("updater") && !u.startsWith("devtools://");
      };

      const pageTarget = targets.find(t => (t.type === "page" || t.type === "webview" || t.type === "app") && isCandidate(t))
        ?? targets.find(isCandidate)
        ?? targets.find(t => t.type === "page" || t.type === "webview" || t.type === "app")
        ?? targets[0];
      if (!pageTarget) {
        throw new Error(`[Weavetab] ✗ No window or webview target found in Electron app "${targetApp}".`);
      }

      const targetId = pageTarget.id || pageTarget.targetId;
      const session = await withCDPTimeout(CDP({ host: "127.0.0.1", port, target: targetId }), 5000, "CDP connect Electron target");

      try {
        (session as any).on("close", () => {
          logDebug(`[Weavetab CDP] Electron session WebSocket closed (${targetApp}) — unregistering.`);
          const iv = analyticsIntervals.get(targetId);
          if (iv) { clearInterval(iv); analyticsIntervals.delete(targetId); }
          clearProfileVerificationCache(targetId);
          clearShadowDomCache(targetId);
          labelCache.invalidate(targetId);
          import("./omni_broker.js").then(m => m.cleanupOmniBroker(targetId)).catch(() => {});
          import("../tools/network_intercept.js").then(m => m.cleanupNetworkIntercept(session as any)).catch(() => {});
          sessionRegistry.unregister(targetId);
        });
        (session as any).on("error", (err: any) => {
          logDebug(`[Weavetab CDP] Electron session WebSocket error (${targetApp}):`, err?.message ?? err);
        });

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
          port,
        };

        sessionRegistry.register(targetId, client);
        return client;
      } catch (err) {
        try { await session.close(); } catch {}
        throw err;
      }
    }

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

    try {
      if (!port) throw new Error("no port yet");
      await withCDPTimeout(CDP.List({ host: "127.0.0.1", port }), 5000, "CDP.List existing");
      actualPort = port;
    } catch {
      logDebug(`[Weavetab CDP] No browser on port ${port ?? "auto"}. Launching new instance...`);
      const profileDir = getSessionProfile(getConfigCookies(config), getConfigProfileDir(config), config.syncDataAcrossBrowsers, getConfigBrowserPath(config));
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
      await withCDPTimeout(CDP.List({ host: "127.0.0.1", port }), 5000, "CDP.List new");
    }

    const metaSession = await withCDPTimeout(CDP({ host: "127.0.0.1", port }), 5000, "CDP metaSession");
    let bctxId = sessionRegistry.getBrowserContextIdForAgent(getConfigAgentId(config));
    let pageTarget: any;
    let agentTargets: any[] = [];

    try {
      const cookiesEnabled = getConfigCookies(config);
      if (cookiesEnabled) {
        bctxId = undefined as any;
      } else if (bctxId) {
        try {
          const { browserContextIds } = await (metaSession.Target as any).getBrowserContexts();
          if (Array.isArray(browserContextIds) && !browserContextIds.includes(bctxId)) {
            bctxId = undefined;
          }
        } catch { /* ignore if unsupported */ }
      }

      if (!bctxId && !cookiesEnabled) {
        try {
          const res = await metaSession.Target.createBrowserContext({ disposeOnDetach: false });
          bctxId = res.browserContextId;
          sessionRegistry.setBrowserContextIdForAgent(getConfigAgentId(config), bctxId);
        } catch (e) {
          logDebug("[Weavetab CDP] Context creation failed, falling back to default context.", e);
        }
      }

      const { targetInfos } = await metaSession.Target.getTargets();
      agentTargets = targetInfos.filter(t => t.type === "page" && (!bctxId || t.browserContextId === bctxId));

      pageTarget = agentTargets.find(t => t.url !== "about:blank" && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"))
        ?? agentTargets.find(t => !t.url.startsWith("chrome-extension://"))
        ?? agentTargets[0];

      if (!pageTarget || pageTarget.url === "about:blank") {
        const newTabUrl = (!activeEngine || activeEngine === "chromium") ? "chrome://newtab/" : "about:blank";
        let createdTargetId: string;
        try {
          const created = await metaSession.Target.createTarget({ url: newTabUrl, browserContextId: bctxId });
          createdTargetId = created.targetId;
        } catch {
          bctxId = undefined;
          const created = await metaSession.Target.createTarget({ url: newTabUrl });
          createdTargetId = created.targetId;
        }
        const staleId = pageTarget?.targetId;
        pageTarget = { targetId: createdTargetId, url: newTabUrl, title: "New Tab", type: "page" } as any;
        if (staleId) {
          await metaSession.Target.closeTarget({ targetId: staleId }).catch(() => {});
        }
      }

      try {
        const blankTabs = agentTargets.filter(t => t.url === "about:blank" && t.targetId !== pageTarget!.targetId);
        for (const bt of blankTabs) {
          await metaSession.Target.closeTarget({ targetId: bt.targetId }).catch(() => {});
        }
      } catch { /* non-fatal */ }
    } finally {
      await metaSession.close().catch(() => {});
    }

    if (!pageTarget) throw new Error("No active page tab found even after launching.");

    const session = await withCDPTimeout(CDP({ host: "127.0.0.1", port, target: pageTarget.targetId }), 5000, "CDP connect target");

    try {
      (session as any).on("close", () => {
        logDebug("[Weavetab CDP] Session WebSocket closed — unregistering.");
        const tid = pageTarget!.targetId;
        const iv = analyticsIntervals.get(tid);
        if (iv) { clearInterval(iv); analyticsIntervals.delete(tid); }
        clearProfileVerificationCache(tid);
        clearShadowDomCache(tid);
        labelCache.invalidate(tid);
        import("./omni_broker.js").then(m => m.cleanupOmniBroker(tid)).catch(() => {});
        import("../tools/network_intercept.js").then(m => m.cleanupNetworkIntercept(session as any)).catch(() => {});
        sessionRegistry.unregister(tid);
      });
      (session as any).on("error", (err: any) => {
        logDebug("[Weavetab CDP] Session WebSocket error:", err?.message ?? err);
      });

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
        } else {
          logDebug(`[Weavetab Security] Browser fingerprint verified`);
        }
      }

      await initSession(session, pageTarget.targetId, port, config);

      const profileCheck = await verifyProfileIsolation(session, config, pageTarget.targetId);
      if (!profileCheck.verified) {
        logDebug(`[Weavetab Security] Profile isolation verification failed - using unexpected profile`);
        logDebug(`[Weavetab Security] Expected: ${profileCheck.expectedProfile}`);
        logDebug(`[Weavetab Security] Actual: ${profileCheck.actualProfile || "unknown"}`);
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
          recordTabActivity(event.targetInfo.targetId);
          try {
            const tabBctxId = (event.targetInfo as any).browserContextId;
            const agentIdForTab = tabBctxId ? sessionRegistry.getAgentForBrowserContextId(tabBctxId) : undefined;
            await connectToTab(event.targetInfo.targetId, port!, agentIdForTab, tabBctxId);
          } catch (e) {
            logDebug(`[Weavetab] Failed to auto-connect to new tab: ${e}`);
          }
        }
      });

      session.Target.on("targetDestroyed", (event) => {
        clearProfileVerificationCache(event.targetId);
        clearShadowDomCache(event.targetId);
        labelCache.invalidate(event.targetId);
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
        port,
      };

      sessionRegistry.register(pageTarget.targetId, client);

      const otherPages = agentTargets.filter(t => t.targetId !== pageTarget!.targetId);
      for (const t of otherPages) {
        connectToTab(t.targetId, port, getConfigAgentId(config), bctxId).catch(() => {});
      }

      return client;
    } catch (err) {
      try { await session.close(); } catch {}
      throw err;
    }
  } finally {
    await releaseMutex();
  }
}

export async function getTabList(agentId?: string, targetApp?: string): Promise<any[]> {
  const config = getCachedConfig();
  const aid = agentId || getConfigAgentId(config);

  let port: number | null = null;
  if (targetApp) {
    const activeAppClient = sessionRegistry.getActive(aid, targetApp);
    if (activeAppClient?.port) {
      port = activeAppClient.port;
    } else {
      const lock = readLock(targetApp);
      if (lock && (await isLockValid(lock))) {
        port = lock.port;
      }
    }
  } else {
    const activeBrowserClient = sessionRegistry.getActive(aid);
    port = activeBrowserClient?.port ?? actualPort;
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
  if (!port) throw new Error(`[!] No active ${targetApp ? targetApp : "browser"} session. Run browser_navigate or launch app first.`);

  let metaSession: CDP.Client | null = null;
  try {
    metaSession = await withCDPTimeout(CDP({ host: "127.0.0.1", port }), 5000, "getTabList CDP");
    const { targetInfos } = await withCDPTimeout(metaSession.Target.getTargets(), 5000, "getTabList getTargets");

    const bctxId = sessionRegistry.getBrowserContextIdForAgent(aid);

    return targetInfos
      .filter(t => {
        const matchType = (t.type === "page" || t.type === "webview" || t.type === "app" || t.type === "other" || t.type === "iframe");
        const matchCtx = (!bctxId || t.browserContextId === bctxId);
        if (!matchType || !matchCtx) return false;
        if (targetApp) {
          const u = (t.url || "").toLowerCase();
          const tit = (t.title || "").toLowerCase();
          if (u.includes("splash") || tit.includes("updater") || u.startsWith("devtools://")) return false;
        }
        return true;
      })
      .map(t => ({
        id: t.targetId,
        title: t.title || t.url || t.type,
        url: t.url,
        type: t.type,
      }));
  } catch {
    throw new Error(`[!] Weavetab cannot reach ${targetApp ? targetApp : "browser"} on port ${port}.`);
  } finally {
    if (metaSession) {
      await metaSession.close().catch(() => {});
    }
  }
}

export async function connectToTab(targetId: string, port?: number, agentId?: string, browserContextId?: string, appName?: string): Promise<BrowserClient> {
  const existing = sessionRegistry.getAll().find(c => c.targetId === targetId);
  if (existing) return existing;

  const currentConfig = getCachedConfig();
  const actualAgentId = agentId || getConfigAgentId(currentConfig);
  const activeForApp = appName ? sessionRegistry.getActive(actualAgentId, appName) : sessionRegistry.getActive(actualAgentId);
  const lock = readLock(appName);
  const p = port || activeForApp?.port || (appName ? lock?.port : (actualPort || lock?.port));
  if (!p) throw new Error(`[!] No active ${appName || "browser"} session. Run browser_navigate first.`);

  let t: any = null;
  try {
    const targets = await withCDPTimeout(CDP.List({ host: "127.0.0.1", port: p }), 3000, "connectToTab CDP.List");
    t = targets.find((item: any) => (item.id || item.targetId) === targetId);
  } catch {}
  if (!t) {
    throw new Error(`Tab not found: "${targetId}". Check browser_tabs({ action: "list" }) for active IDs.`);
  }

  let session: CDP.Client;
  try {
    session = await withCDPTimeout(CDP({ host: "127.0.0.1", port: p, target: targetId }), 5000, "connectToTab CDP");
  } catch (err: any) {
    if (err?.message?.includes("webSocketDebuggerUrl") || err?.message?.includes("Cannot read propert")) {
      throw new Error(`Tab not found or closed: "${targetId}".`);
    }
    throw err;
  }

  try {
    (session as any).on("close", () => {
      logDebug(`[Weavetab CDP] connectToTab session closed (${appName || "browser"}) — unregistering.`);
      const iv = analyticsIntervals.get(targetId);
      if (iv) { clearInterval(iv); analyticsIntervals.delete(targetId); }
      clearProfileVerificationCache(targetId);
      clearShadowDomCache(targetId);
      labelCache.invalidate(targetId);
      import("./omni_broker.js").then(m => m.cleanupOmniBroker(targetId)).catch(() => {});
      import("../tools/network_intercept.js").then(m => m.cleanupNetworkIntercept(session as any)).catch(() => {});
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

    await initSession(session, targetId, p, currentConfig, !!appName);

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
      port: p,
    };

    sessionRegistry.register(targetId, client);
    return client;
  } catch (err) {
    try { await session.close(); } catch {}
    throw err;
  }
}

export async function cleanupIntervals(): Promise<void> {
  for (const iv of analyticsIntervals.values()) clearInterval(iv);
  analyticsIntervals.clear();

  const clients = sessionRegistry.getAll();
  await Promise.allSettled(
    clients.map(async (client) => {
      let t: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve(client.session.close()).catch(() => {}),
          new Promise<void>((resolve) => {
            t = setTimeout(resolve, 500);
            t.unref?.();
          }),
        ]);
      } finally {
        if (t) clearTimeout(t);
        try { sessionRegistry.unregister(client.targetId); } catch {}
      }
    })
  );
}

export async function cleanupAll(): Promise<void> {
  const clients = sessionRegistry.getAll();
  const closedPorts = new Set<number | string>();

  for (const client of clients) {
    const portKey = client.port ?? (client.appName ? `app:${client.appName}` : "default");
    if (closedPorts.has(portKey)) continue;
    closedPorts.add(portKey);
    try {
      await client.session.Browser.close();
    } catch { /* ignore */ }
  }

  await cleanupIntervals();
}
