import { findBrowser, findFirefox, probeAllBrowsers } from "../cdp/bridge.js";
import { getCachedConfig, getElectronApps, type BrowserEngine, type ElectronAppConfig } from "../config/loader.js";

// Phase 8c: Per-engine tool coverage map
// Firefox CDP is ~80% feature-complete; WebKit is ~60%
const ENGINE_COVERAGE: Record<BrowserEngine, { coverage: number; unsupported: string[] }> = {
  chromium: { coverage: 100, unsupported: [] },
  firefox: {
    coverage: 78,
    unsupported: [
      "browser_network_intercept",
      "browser_viewport",
      "browser_recording",
      "browser_thought",
      "browser_highlight",
      "browser_inspect",
      "browser_snapshot",
      "browser_storage",
      "browser_automation",
    ],
  },
  webkit: {
    coverage: 55,
    unsupported: [
      "browser_network_intercept",
      "browser_viewport",
      "browser_recording",
      "browser_thought",
      "browser_highlight",
      "browser_inspect",
      "browser_snapshot",
      "browser_storage",
      "browser_automation",
      "browser_burst",
      "browser_pointer",
      "browser_select",
      "browser_upload",
      "browser_cookies",
      "browser_canvas",
      "browser_clipboard",
    ],
  },
};

import { sessionRegistry } from "../state/session.js";
import { getTabList } from "../cdp/connector.js";
import { getConfigAgentId } from "../config/loader.js";
import { discoverElectronApps, type DiscoveredElectronApp } from "../desktop/discovery.js";

export interface ConfiguredAppStatus {
  name: string;
  status: "connected" | "running_no_debug" | "offline";
  configuredPath?: string;
  activeTabs?: { id: string; title: string; url: string }[];
  port?: number;
}

export interface BrowserDetectResult {
  available: { engine: BrowserEngine; name: string; path: string }[];
  current: BrowserEngine;
  configuredApps?: ConfiguredAppStatus[];
  runningUnconfiguredApps?: DiscoveredElectronApp[];
  toolCoverage: Record<string, number>;
  unsupportedTools: Record<string, string[]>;
}

export async function detectBrowsers(currentEngine: BrowserEngine): Promise<BrowserDetectResult> {
  const available: { engine: BrowserEngine; name: string; path: string }[] = [];

  // Detect Chromium-based browsers
  const allBrowsers = probeAllBrowsers();
  for (const b of allBrowsers) {
    available.push({ engine: "chromium", name: b.name, path: b.path });
  }

  // Detect Firefox
  const ff = findFirefox();
  if (ff) {
    available.push({ engine: "firefox", name: ff.name, path: ff.path });
  }

  const toolCoverage: Record<string, number> = {};
  const unsupportedMap: Record<string, string[]> = {};
  for (const engine of ["chromium", "firefox", "webkit"] as BrowserEngine[]) {
    toolCoverage[engine] = ENGINE_COVERAGE[engine].coverage;
    unsupportedMap[engine] = [...ENGINE_COVERAGE[engine].unsupported];
  }

  const config = getCachedConfig();
  const electronApps = getElectronApps(config);
  const runningElectronApps = await discoverElectronApps().catch(() => []);
  
  const configuredApps: ConfiguredAppStatus[] = [];
  const runningUnconfiguredApps: DiscoveredElectronApp[] = [];

  // Identify configured app statuses
  for (const [appName, appCfg] of Object.entries(electronApps)) {
    const clients = sessionRegistry.getAllForAgent(getConfigAgentId(config));
    const activeClient = clients.find(c => c.isElectron && c.appName === appName);
    
    let status: ConfiguredAppStatus["status"] = "offline";
    let activeTabs: any[] = [];
    let port: number | undefined;

    if (activeClient) {
      status = "connected";
      port = activeClient.port;
      try {
        const tabs = await getTabList(getConfigAgentId(config), appName);
        activeTabs = tabs.map(t => ({ id: t.id, title: t.title, url: t.url }));
      } catch { /* ignore tab list failure */ }
    } else {
      const running = runningElectronApps.find(r => r.name.toLowerCase() === appName.toLowerCase());
      if (running) {
        status = running.status === "debug_port_open" ? "connected" : "running_no_debug";
        port = running.port;
      }
    }

    configuredApps.push({
      name: appName,
      status,
      configuredPath: appCfg.path,
      activeTabs: activeTabs.length > 0 ? activeTabs : undefined,
      port
    });
  }

  // Find running apps that are not configured
  for (const running of runningElectronApps) {
    const isConfigured = Object.keys(electronApps).some(n => n.toLowerCase() === running.name.toLowerCase());
    if (!isConfigured) {
      runningUnconfiguredApps.push(running);
    }
  }

  return {
    available,
    current: currentEngine,
    configuredApps: configuredApps.length > 0 ? configuredApps : undefined,
    runningUnconfiguredApps: runningUnconfiguredApps.length > 0 ? runningUnconfiguredApps : undefined,
    toolCoverage,
    unsupportedTools: unsupportedMap,
  };
}

export function isToolSupported(engine: BrowserEngine, toolName: string): boolean {
  return !ENGINE_COVERAGE[engine]?.unsupported.includes(toolName);
}
