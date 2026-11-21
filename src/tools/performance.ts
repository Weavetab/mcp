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
    await session.Performance.enable().catch(() => {});
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
        const collect = (field, opts) => new Promise((resolve) => {
          let value = field === 'cls' ? 0 : -1;
          let obs = null;
          try {
            obs = new PerformanceObserver((list) => {
              for (const e of list.getEntries()) {
                if (field === 'lcp') value = Math.max(value, e.startTime || 0);
                else if (field === 'cls') { if (!e.hadRecentInput) value += e.value || 0; }
                else if (field === 'inp') value = Math.max(value, e.duration || 0);
              }
            });
            obs.observe(opts);
          } catch {}
          setTimeout(() => {
            try { if (obs) obs.disconnect(); } catch {}
            resolve(value);
          }, 50);
        });
        const [lcp, cls, inp] = await Promise.all([
          collect('lcp', { type: 'largest-contentful-paint', buffered: true }),
          collect('cls', { type: 'layout-shift', buffered: true }),
          collect('inp', { type: 'event', buffered: true, durationThreshold: 16 }),
        ]);
        return JSON.stringify({
          fcp: fcpEntry ? fcpEntry.startTime : -1,
          ttfb: nav ? Math.max(0, nav.responseStart - nav.requestStart) : -1,
          domContentLoaded: nav ? nav.domContentLoadedEventEnd : -1,
          load: nav ? nav.loadEventEnd : -1,
          lcp,
          cls,
          inp
        });
      })()`,
      returnByValue: true,
      awaitPromise: true,
    });
    try { out.vitals = JSON.parse(result.value as string); } catch { out.vitals = {}; }
  }

  const wantMem = sections.has("memory");
  const wantNav = sections.has("navigation");
  const wantRes = sections.has("resources");
  if (wantMem || wantNav || wantRes) {
    const { result } = await session.Runtime.evaluate({
      expression: `JSON.stringify((function() {
        var bundle = {};
        if (${wantMem}) {
          bundle.memory = performance.memory ? {
            usedJSHeapSize: performance.memory.usedJSHeapSize,
            totalJSHeapSize: performance.memory.totalJSHeapSize,
            jsHeapSizeLimit: performance.memory.jsHeapSizeLimit
          } : {};
        }
        if (${wantNav}) {
          var n = performance.getEntriesByType('navigation')[0];
          bundle.navigation = n ? {
            type: n.type, redirectCount: n.redirectCount, domInteractive: n.domInteractive,
            domContentLoadedEventEnd: n.domContentLoadedEventEnd, loadEventEnd: n.loadEventEnd,
            transferSize: n.transferSize, encodedBodySize: n.encodedBodySize, decodedBodySize: n.decodedBodySize
          } : null;
        }
        if (${wantRes}) {
          bundle.slowest_resources = performance.getEntriesByType('resource')
            .map(function(r){ return { name: r.name, duration: r.duration, transferSize: r.transferSize, initiatorType: r.initiatorType }; })
            .sort(function(a, b){ return b.duration - a.duration; })
            .slice(0, 10);
        }
        return bundle;
      })())`,
      returnByValue: true,
    });
    try {
      const parsed = JSON.parse(result.value as string);
      if (wantMem) out.memory = parsed.memory ?? {};
      if (wantNav) out.navigation = parsed.navigation ?? null;
      if (wantRes) out.slowest_resources = parsed.slowest_resources ?? [];
    } catch {
      if (wantMem) out.memory = {};
      if (wantNav) out.navigation = null;
      if (wantRes) out.slowest_resources = [];
    }
  }

  return out;
}
