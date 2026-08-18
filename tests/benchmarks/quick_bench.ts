/**
 * quick_bench.ts — Quick 20-action benchmark with live stderr output
 * Run: npx tsx tests/benchmarks/quick_bench.ts
 */
import { loadConfigSync } from "../../src/config/loader.js";
import { getOrConnect } from "../../src/cdp/connector.js";
import { weaveClick } from "../../src/tools/click.js";
import { weaveType } from "../../src/tools/type.js";
import { browserMap } from "../../src/tools/read.js";
import { weaveNavigate } from "../../src/tools/navigate.js";
import { browserBurst } from "../../src/tools/burst.js";
import { browserScroll } from "../../src/tools/scroll.js";
import { buildActionMap } from "../../src/cdp/walker.js";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const config = loadConfigSync();
  const { session } = await getOrConnect(config);
  const steps: any[] = [];
  const startWall = Date.now();

  const log = (msg: string) => console.error(msg);
  const step = (label: string, fn: () => Promise<any>) => async () => {
    const t0 = Date.now();
    try {
      const r = await fn();
      const ms = Date.now() - t0;
      const ok = r?.success !== false;
      log(`  ${ok ? "✅" : "❌"} ${label} (${ms}ms)`);
      steps.push({ label, durationMs: ms, success: ok, outputBytes: JSON.stringify(r || {}).length });
    } catch (e: any) {
      const ms = Date.now() - t0;
      log(`  ❌ ${label} FAILED (${ms}ms): ${e.message?.slice(0, 60)}`);
      steps.push({ label, durationMs: ms, success: false, outputBytes: 0 });
    }
  };

  // 1. Navigate
  log("\n── Navigate ──");
  await step("navigate to form", () => weaveNavigate(session, "https://httpbin.org/forms/post", config))();
  await sleep(1000);

  // 2. browser_map
  log("\n── browser_map ──");
  await step("map 1", () => browserMap(session, { prune: true }, "default", config))();
  await step("map 2", () => browserMap(session, { prune: true }, "default", config))();

  // 3. Click
  log("\n── weaveClick ──");
  await step("click Submit order", () => weaveClick(session, { label: "Submit order" }, config))();
  await step("click Large radio", () => weaveClick(session, { label: "Large" }, config))();
  await step("click nonexistent", () => weaveClick(session, { label: "__bad__" }, config))();

  // 4. Type by ref ID (build map once, find text input)
  log("\n── weaveType ──");
  await weaveNavigate(session, "https://httpbin.org/forms/post", config);
  await sleep(2000);
  const map = await buildActionMap(session, { prune: true }, "default");
  const textInput = map.elements.find((el: any) => el.role === "textbox");
  const ref = textInput?.id || "w:wts19r5c";
  await step(`type "Hello" into ${ref}`, () => weaveType(session, { id: ref, text: "Hello" }, config))();
  await step(`type "World" into ${ref}`, () => weaveType(session, { id: ref, text: "World" }, config))();

  // 5. Scroll
  log("\n── browserScroll ──");
  await step("scroll down", () => browserScroll(session, { direction: "down", distance: 300 }, config))();
  await step("scroll up", () => browserScroll(session, { direction: "up", distance: 200 }, config))();

  // 6. Burst
  log("\n── browserBurst ──");
  await step("burst map+scroll", () => browserBurst(session, {
    steps: [
      { tool: "browser_map", args: { prune: true } },
      { tool: "browser_scroll", args: { direction: "down", distance: 100 } }
    ],
  }, config))();

  // 7. Navigate to example
  log("\n── Navigate ──");
  await step("navigate to example", () => weaveNavigate(session, "https://example.com", config))();

  // Compute stats
  const totalMs = Date.now() - startWall;
  const durations = steps.map(s => s.durationMs).sort((a, b) => a - b);
  const avg = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
  const p50 = durations[Math.floor(durations.length * 0.5)];
  const p95 = durations[Math.floor(durations.length * 0.95)];
  const totalBytes = steps.reduce((a, s) => a + s.outputBytes, 0);
  const failures = steps.filter(s => !s.success).length;

  log(`\n========================================`);
  log(`Actions: ${steps.length} | Total: ${totalMs}ms | Avg: ${avg}ms`);
  log(`p50: ${p50}ms | p95: ${p95}ms`);
  log(`Failures: ${failures}/${steps.length}`);
  log(`Output: ${(totalBytes / 1024).toFixed(1)}KB`);
  log(`========================================`);

  // JSON report on stdout
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    totalActions: steps.length,
    totalDurationMs: totalMs,
    avgDurationMs: avg,
    p50Ms: p50,
    p95Ms: p95,
    failures,
    totalOutputBytes: totalBytes,
    avgOutputBytes: Math.round(totalBytes / steps.length),
    steps,
  }, null, 2));

  await session.close().catch(() => {});
  process.exit(0);
}
main();
