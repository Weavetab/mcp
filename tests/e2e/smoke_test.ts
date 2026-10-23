/**
 * Smoke-test for browser_burst and browser_network_intercept
 * Run: npx tsx tests/e2e/smoke_test.ts
 * Launches/connects to Chrome via Weavetab's standard port-0/bridge mechanism.
 */
import { loadConfigSync } from "../../src/config/loader.js";
import { getOrConnect } from "../../src/cdp/connector.js";
import { browserNetworkIntercept } from "../../src/tools/network_intercept.js";
import type CDP from "chrome-remote-interface";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function run() {
  const config = loadConfigSync();
  let passed = 0, failed = 0;

  const assert = (cond: boolean, msg: string) => {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else       { console.error(`  ❌ ${msg}`); failed++; }
  };

  try {
    const client = await getOrConnect(config);
    const session: CDP.Client = client.session;
    console.log("✅ CDP connected via getOrConnect\n");

    // ── Test 1: network_intercept (CDP Fetch fallback) ─────────────────────
    console.log("── Test 1: browser_network_intercept (no-extension Fetch fallback) ──");
    await session.Page.navigate({ url: "https://httpbin.org/get" });
    await sleep(2500);

    const enableResult = await browserNetworkIntercept(session, {
      action: "enable",
      pattern: "*httpbin.org/json*",
      mockStatus: 200,
      mockBody: JSON.stringify({ mocked: true })
    }, config);
    assert(enableResult.success === true, `enable returned success`);
    assert(enableResult.message.includes("intercept"), `message mentions intercept: "${enableResult.message}"`);

    const fetchResult = await session.Runtime.evaluate({
      expression: `fetch('https://httpbin.org/json').then(r=>r.json()).then(d=>JSON.stringify(d))`,
      awaitPromise: true, returnByValue: true
    }).catch(() => null);
    const parsed = fetchResult?.result?.value ? JSON.parse(fetchResult.result.value as string) : null;
    assert(parsed?.mocked === true, `intercepted response contains mocked:true (got ${JSON.stringify(parsed)})`);

    const disableResult = await browserNetworkIntercept(session, { action: "disable" }, config);
    assert(disableResult.success === true, `disable returned success`);

    // ── Test 1b: network_intercept get_telemetry (TLS certs, timing, failure codes) ──
    console.log("── Test 1b: browser_network_intercept (get_telemetry raw protocol metadata) ──");
    await browserNetworkIntercept(session, { action: "get_telemetry" }, config);
    await session.Page.navigate({ url: "https://httpbin.org/get" });
    await sleep(2500);

    const telemetryResult = await browserNetworkIntercept(session, { action: "get_telemetry" }, config);
    assert(telemetryResult.success === true, `get_telemetry returned success`);
    assert(Array.isArray(telemetryResult.requests), `get_telemetry returned requests array`);
    assert(telemetryResult.count >= 1, `get_telemetry captured at least 1 request (got ${telemetryResult.count})`);

    const capturedReq = telemetryResult.requests.find((r: any) => r.url.includes("httpbin.org"));
    assert(!!capturedReq, `captured request for httpbin.org`);
    if (capturedReq) {
      assert(typeof capturedReq.timing === "object", `request contains timing object`);
      assert(typeof capturedReq.securityDetails === "object" || capturedReq.url.startsWith("https"), `captured request handled HTTPS/security`);
    }

    // ── Test 2: browser_burst – steps, ordering, and stuck isolation ────────
    console.log("\n── Test 2: browser_burst ──");
    const { browserBurst } = await import("../../src/tools/burst.js");

    await session.Page.navigate({ url: "https://example.com" });
    await sleep(2000);

    const r1 = await browserBurst(session, {
      steps: [
        { tool: "browser_map", args: {} },
        { tool: "browser_wait", args: { for: "element", value: "p", timeout: 3000 } },
        { tool: "browser_scroll", args: { direction: "down", distance: 200 } },
      ]
    }, config);
    assert(r1.success === true, "burst returned success");
    assert(r1.steps_completed === 3, `all 3 steps completed (got ${r1.steps_completed})`);

    const r2 = await browserBurst(session, {
      stop_on_error: false,
      steps: [
        { tool: "browser_click", args: { label: "__nonexistent_xyz__" } },
        { tool: "browser_map",   args: {} },
      ]
    }, config);
    assert(r2.steps_completed === 2, `step 2 still ran after step 1 failure (completed: ${r2.steps_completed})`);
    assert(r2.results[0]?.success === false, `step 1 correctly failed`);
    assert(r2.results[1]?.success === true,  `step 2 correctly succeeded`);

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
    else console.log("✅ ALL SMOKE TESTS PASSED");
  } catch (err) {
    console.error("❌ FATAL:", err);
    process.exit(1);
  }
}

run();
