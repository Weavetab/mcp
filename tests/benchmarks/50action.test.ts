/**
 * 50action.test.ts — Phase 1.6
 * 50-action session benchmark: measures actual MCP calls, token usage, latency.
 * Run: npx tsx tests/benchmarks/50action.test.ts
 * Uses Weavetab's standard port-0/bridge connection mechanism (no hardcoded port).
 *
 * Output: JSON report with per-action timing and summary stats.
 */
import { loadConfigSync } from "../../src/config/loader.js";
import { getOrConnect } from "../../src/cdp/connector.js";
import { weaveClick } from "../../src/tools/click.js";
import { weaveType } from "../../src/tools/type.js";
import { browserMap } from "../../src/tools/read.js";
import { weaveNavigate } from "../../src/tools/navigate.js";
import { browserBurst } from "../../src/tools/burst.js";
import { browserScroll } from "../../src/tools/scroll.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface BenchmarkStep {
  tool: string;
  action: string;
  durationMs: number;
  success: boolean;
  outputBytes: number;
  stuckWarning: boolean;
}

interface BenchmarkReport {
  timestamp: string;
  totalActions: number;
  totalDurationMs: number;
  avgDurationMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  totalOutputBytes: number;
  avgOutputBytes: number;
  failures: number;
  stuckWarnings: number;
  steps: BenchmarkStep[];
  compareMd: {
    claimedActionsPerCall: number;
    actualActionsPerCall: number;
    claimedTokenEfficiency: string;
    notes: string[];
  };
}

async function runBenchmark() {
  const config = loadConfigSync();
  const steps: BenchmarkStep[] = [];
  const startTime = Date.now();

  try {
    const { session } = await getOrConnect(config);
    console.error("✅ CDP connected via getOrConnect");

    // 1-3: Navigate to test pages
    for (const url of ["https://httpbin.org/forms/post", "https://example.com", "https://httpbin.org/forms/post"]) {
      const t0 = Date.now();
      try {
        const r = await weaveNavigate(session, url, config);
        const ms = Date.now() - t0;
        steps.push({ tool: "browser_navigate", action: url, durationMs: ms, success: r.success, outputBytes: JSON.stringify(r).length, stuckWarning: false });
      } catch (e: any) {
        steps.push({ tool: "browser_navigate", action: url, durationMs: Date.now() - t0, success: false, outputBytes: 0, stuckWarning: false });
      }
    }

    // 4-13: browser_map (10 calls)
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      try {
        const r = await browserMap(session, { prune: true }, "default", config);
        const ms = Date.now() - t0;
        steps.push({ tool: "browser_map", action: `map-${i}`, durationMs: ms, success: true, outputBytes: r.length, stuckWarning: false });
      } catch (e: any) {
        steps.push({ tool: "browser_map", action: `map-${i}`, durationMs: Date.now() - t0, success: false, outputBytes: 0, stuckWarning: false });
      }
    }

    // 14-23: weaveClick (10 clicks)
    const clickTargets = [
      { label: "Submit order" }, { label: "Large" },
      { label: "Submit order" }, { label: "__nonexistent__" },
      { label: "Submit order" }, { label: "Medium" },
      { label: "Submit order" }, { label: "__nonexistent__" },
      { label: "Submit order" }, { label: "Submit order" },
    ];
    for (const target of clickTargets) {
      const t0 = Date.now();
      try {
        const r: any = await weaveClick(session, target, config);
        const ms = Date.now() - t0;
        steps.push({
          tool: "browser_click",
          action: target.label,
          durationMs: ms,
          success: r.success,
          outputBytes: JSON.stringify(r).length,
          stuckWarning: r.stuck_warning === true,
        });
      } catch (e: any) {
        steps.push({ tool: "browser_click", action: target.label, durationMs: Date.now() - t0, success: false, outputBytes: 0, stuckWarning: false });
      }
      await sleep(500);
    }

    // 24-33: weaveType (10 typing actions)
    await weaveNavigate(session, "https://httpbin.org/forms/post", config);
    const typeTexts = [
      { label: "Customer name", text: "Alice" },
      { label: "Customer name", text: "Bob" },
      { label: "Customer name", text: "Charlie" },
      { label: "Customer name", text: "Diana" },
      { label: "Customer name", text: "Eve" },
      { label: "Customer name", text: "Frank" },
      { label: "Customer name", text: "Grace" },
      { label: "Customer name", text: "Henry" },
      { label: "Customer name", text: "Iris" },
      { label: "Customer name", text: "Jack" },
    ];
    for (const tt of typeTexts) {
      const t0 = Date.now();
      try {
        const r: any = await weaveType(session, tt, config);
        const ms = Date.now() - t0;
        steps.push({
          tool: "browser_type",
          action: tt.text,
          durationMs: ms,
          success: r.success,
          outputBytes: JSON.stringify(r).length,
          stuckWarning: r.stuck_warning === true,
        });
      } catch (e: any) {
        steps.push({ tool: "browser_type", action: tt.text, durationMs: Date.now() - t0, success: false, outputBytes: 0, stuckWarning: false });
      }
      await sleep(200);
    }

    // 34-38: weaveClick on radio buttons (5 clicks)
    await weaveNavigate(session, "https://httpbin.org/forms/post", config);
    const radioValues = ["Large", "Medium", "Small", "Medium", "Large"];
    for (const val of radioValues) {
      const t0 = Date.now();
      try {
        const r: any = await weaveClick(session, { label: val }, config);
        const ms = Date.now() - t0;
        steps.push({ tool: "browser_click", action: `radio:${val}`, durationMs: ms, success: r.success !== false, outputBytes: JSON.stringify(r).length, stuckWarning: r.stuck_warning === true });
      } catch (e: any) {
        steps.push({ tool: "browser_click", action: `radio:${val}`, durationMs: Date.now() - t0, success: false, outputBytes: 0, stuckWarning: false });
      }
      await sleep(200);
    }

    // 39-43: browserScroll (5 scrolls)
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      try {
        const r = await browserScroll(session, { direction: "down", distance: 200 }, config);
        const ms = Date.now() - t0;
        steps.push({ tool: "browser_scroll", action: `scroll-${i}`, durationMs: ms, success: r.success, outputBytes: JSON.stringify(r).length, stuckWarning: false });
      } catch (e: any) {
        steps.push({ tool: "browser_scroll", action: `scroll-${i}`, durationMs: Date.now() - t0, success: false, outputBytes: 0, stuckWarning: false });
      }
    }

    // 44-48: browserBurst (5 bursts)
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      try {
        const r = await browserBurst(session, {
          steps: [
            { tool: "browser_map", args: { prune: true } },
            { tool: "browser_scroll", args: { direction: "down", distance: 100 } },
          ],
        }, config);
        const ms = Date.now() - t0;
        steps.push({ tool: "browser_burst", action: `burst-${i}`, durationMs: ms, success: r.success, outputBytes: JSON.stringify(r).length, stuckWarning: false });
      } catch (e: any) {
        steps.push({ tool: "browser_burst", action: `burst-${i}`, durationMs: Date.now() - t0, success: false, outputBytes: 0, stuckWarning: false });
      }
    }

    // 49-50: Two more navigations
    for (const url of ["https://example.com", "https://httpbin.org/get"]) {
      const t0 = Date.now();
      try {
        const r = await weaveNavigate(session, url, config);
        const ms = Date.now() - t0;
        steps.push({ tool: "browser_navigate", action: url, durationMs: ms, success: r.success, outputBytes: JSON.stringify(r).length, stuckWarning: false });
      } catch (e: any) {
        steps.push({ tool: "browser_navigate", action: url, durationMs: Date.now() - t0, success: false, outputBytes: 0, stuckWarning: false });
      }
    }

    // ── Compute statistics ──────────────────────────────────────────
    const durations = steps.map(s => s.durationMs).sort((a, b) => a - b);
    const totalDuration = Date.now() - startTime;
    const avgDuration = durations.reduce((a, b) => a + b, 0) / durations.length;
    const p50 = durations[Math.floor(durations.length * 0.5)];
    const p95 = durations[Math.floor(durations.length * 0.95)];
    const p99 = durations[Math.floor(durations.length * 0.99)];
    const totalBytes = steps.reduce((a, s) => a + s.outputBytes, 0);
    const failures = steps.filter(s => !s.success).length;
    const stuckWarnings = steps.filter(s => s.stuckWarning).length;

    const report: BenchmarkReport = {
      timestamp: new Date().toISOString(),
      totalActions: steps.length,
      totalDurationMs: totalDuration,
      avgDurationMs: Math.round(avgDuration),
      p50Ms: p50,
      p95Ms: p95,
      p99Ms: p99,
      totalOutputBytes: totalBytes,
      avgOutputBytes: Math.round(totalBytes / steps.length),
      failures,
      stuckWarnings,
      steps,
      compareMd: {
        claimedActionsPerCall: 3,
        actualActionsPerCall: steps.length > 0 ? Math.round(50 / (steps.filter(s => s.tool === "browser_burst").length || 1)) : 0,
        claimedTokenEfficiency: "9x vs Playwright",
        notes: [
          `50 actions completed in ${totalDuration}ms (${Math.round(totalDuration / 50)}ms/action avg)`,
        ],
      },
    };

    // ── Output report ────────────────────────────────────────────────
    console.log(JSON.stringify(report, null, 2));

    console.error(`\n=== BENCHMARK SUMMARY ===`);
    console.error(`Actions: ${steps.length} | Total: ${totalDuration}ms | Avg: ${Math.round(avgDuration)}ms`);
    console.error(`p50: ${p50}ms | p95: ${p95}ms | p99: ${p99}ms`);
    console.error(`Failures: ${failures} | Stuck: ${stuckWarnings}`);
    console.error(`Output: ${(totalBytes / 1024).toFixed(1)}KB total, ${Math.round(totalBytes / steps.length)}B/action`);
    console.error(`=== END ===`);

  } catch (err) {
    console.error("❌ FATAL:", err);
    process.exit(1);
  }
}

runBenchmark();
