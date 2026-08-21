import { findBrowser, findFirefox, probeAllBrowsers } from "../cdp/bridge.js";
import type { BrowserEngine } from "../config/loader.js";

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

export interface BrowserDetectResult {
  available: { engine: BrowserEngine; name: string; path: string }[];
  current: BrowserEngine;
  toolCoverage: Record<string, number>;
  unsupportedTools: Record<string, string[]>;
}

export function detectBrowsers(currentEngine: BrowserEngine): BrowserDetectResult {
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

  // WebKit detection is best-effort (Safari Technology Preview)
  // We do not auto-detect WebKit — only report if manually configured

  const toolCoverage: Record<string, number> = {};
  const unsupportedTools: Record<string, string[]> = {};
  for (const engine of ["chromium", "firefox", "webkit"] as BrowserEngine[]) {
    toolCoverage[engine] = ENGINE_COVERAGE[engine].coverage;
    unsupportedTools[engine] = [...ENGINE_COVERAGE[engine].unsupported];
  }

  return {
    available,
    current: currentEngine,
    toolCoverage,
    unsupportedTools,
  };
}

export function isToolSupported(engine: BrowserEngine, toolName: string): boolean {
  return !ENGINE_COVERAGE[engine]?.unsupported.includes(toolName);
}
