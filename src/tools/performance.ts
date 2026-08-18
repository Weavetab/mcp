/**
 * Weavetab — tools/performance.ts
 * browser_performance: Retrieve page performance metrics (FCP, LCP, TTI).
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";

export async function browserPerformance(
  session: CDP.Client,
  _config: Config
): Promise<{ success: boolean; metrics: Record<string, number>; slowest_resources?: any[] }> {
  
  const { metrics: perfMetrics } = await session.Performance.getMetrics();
  
  const parsed: Record<string, number> = {};
  for (const m of perfMetrics) {
    parsed[m.name] = m.value;
  }

  // Also grab FCP from the page itself
  const { result } = await session.Runtime.evaluate({
    expression: `
      new Promise(resolve => {
        const p = performance.getEntriesByType('paint');
        const fcp = p.find(x => x.name === 'first-contentful-paint');
        if (fcp) return resolve({ fcp: fcp.startTime });
        new PerformanceObserver((list) => {
          const entries = list.getEntries();
          resolve({ fcp: entries[0].startTime });
        }).observe({type: 'paint', buffered: true});
        setTimeout(() => resolve({ fcp: -1 }), 1000);
      })
    `,
    returnByValue: true,
    awaitPromise: true
  });

  if (result.value && (result.value as any).fcp !== -1) {
    parsed.FirstContentfulPaint = (result.value as any).fcp;
  }

  // Grab resource timings
  const { result: resourceResult } = await session.Runtime.evaluate({
    expression: `
      JSON.stringify(performance.getEntriesByType('resource').map(r => ({
        name: r.name,
        duration: r.duration,
        transferSize: r.transferSize,
        initiatorType: r.initiatorType
      })).sort((a, b) => b.duration - a.duration).slice(0, 10))
    `,
    returnByValue: true
  });
  
  let resources = [];
  try {
    if (resourceResult.value) {
      resources = JSON.parse(resourceResult.value);
    }
  } catch {}

  return { success: true, metrics: parsed, slowest_resources: resources };
}
