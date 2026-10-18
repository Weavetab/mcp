/**
 * Weavetab — tools/performance.ts
 * browser_performance: page performance metrics — Core Web Vitals, memory, navigation timing, resources, raw CDP counters.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";

export interface PerformanceOptions {
  metrics?: ("vitals" | "memory" | "navigation" | "resources" | "raw")[];
}

export interface PerformanceResult {
  success: boolean;
  metrics?: Record<string, number>;
  vitals?: Record<string, number>;
  memory?: Record<string, number>;
  navigation?: Record<string, any> | null;
  slowest_resources?: any[];
}

const ALL_SECTIONS: ("vitals" | "memory" | "navigation" | "resources" | "raw")[] = [
  "vitals",
  "memory",
  "navigation",
  "resources",
  "raw",
];

export async function browserPerformance(
  session: CDP.Client,
  _config: Config,
  options: PerformanceOptions = {}
): Promise<PerformanceResult> {
  const sections = new Set(options.metrics && options.metrics.length > 0 ? options.metrics : ALL_SECTIONS);
  const out: PerformanceResult = { success: true };

  if (sections.has("raw")) {
    const { metrics: perfMetrics } = await session.Performance.getMetrics();
    const parsed: Record<string, number> = {};
    for (const m of perfMetrics) parsed[m.name] = m.value;
    out.metrics = parsed;
  }

  if (sections.has("vitals")) {
    const { result } = await session.Runtime.evaluate({
      expression: `(async () => {
        const nav = performance.getEntriesByType('navigation')[0];
        const paint = performance.getEntriesByType('paint');
        const fcpEntry = paint.find(x => x.name === 'first-contentful-paint');
        const vitals = {
          fcp: fcpEntry ? fcpEntry.startTime : -1,
          ttfb: nav ? Math.max(0, nav.responseStart - nav.requestStart) : -1,
          domContentLoaded: nav ? nav.domContentLoadedEventEnd : -1,
          load: nav ? nav.loadEventEnd : -1,
          lcp: -1,
          cls: -1,
          inp: -1
        };
        const collect = (type, field, opts) => new Promise((resolve) => {
          let value = field === 'cls' ? 0 : 0;
          try {
            const obs = new PerformanceObserver((list) => {
              for (const e of list.getEntries()) {
                if (field === 'lcp') value = Math.max(value, e.startTime || 0);
                else if (field === 'cls') { if (!e.hadRecentInput) value += e.value || 0; }
                else if (field === 'inp') value = Math.max(value, e.duration || 0);
              }
            });
            obs.observe(opts);
          } catch {}
          setTimeout(() => resolve(value), 50);
        });
        vitals.lcp = await collect('largest-contentful-paint', 'lcp', { type: 'largest-contentful-paint', buffered: true });
        vitals.cls = await collect('layout-shift', 'cls', { type: 'layout-shift', buffered: true });
        vitals.inp = await collect('event', 'inp', { type: 'event', buffered: true, durationThreshold: 16 });
        return JSON.stringify(vitals);
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    try { out.vitals = JSON.parse(result.value as string); } catch { out.vitals = {}; }
  }

  if (sections.has("memory")) {
    const { result } = await session.Runtime.evaluate({
      expression: `JSON.stringify(performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : {})`,
      returnByValue: true,
    });
    try { out.memory = JSON.parse(result.value as string); } catch { out.memory = {}; }
  }

  if (sections.has("navigation")) {
    const { result } = await session.Runtime.evaluate({
      expression: `JSON.stringify((function(){ var n = performance.getEntriesByType('navigation')[0]; if (!n) return null; return { type: n.type, redirectCount: n.redirectCount, domInteractive: n.domInteractive, domContentLoadedEventEnd: n.domContentLoadedEventEnd, loadEventEnd: n.loadEventEnd, transferSize: n.transferSize, encodedBodySize: n.encodedBodySize, decodedBodySize: n.decodedBodySize }; })())`,
      returnByValue: true,
    });
    try { out.navigation = JSON.parse(result.value as string); } catch { out.navigation = null; }
  }

  if (sections.has("resources")) {
    const { result } = await session.Runtime.evaluate({
      expression: `JSON.stringify(performance.getEntriesByType('resource').map(function(r){ return { name: r.name, duration: r.duration, transferSize: r.transferSize, initiatorType: r.initiatorType }; }).sort(function(a, b){ return b.duration - a.duration; }).slice(0, 10))`,
      returnByValue: true,
    });
    try { out.slowest_resources = JSON.parse(result.value as string); } catch { out.slowest_resources = []; }
  }

  return out;
}
