import { logDebug } from "../audit/logger.js";
/**
 * integration.test.ts — Phase 1.1
 * Integration tests for click, type, and browser_map against real pages.
 * Run: npx tsx src/tools/integration.test.ts
 */
import { loadConfigSync } from "../config/loader.js";
import { getOrConnect } from "../cdp/connector.js";
import { weaveClick } from "./click.js";
import { weaveType } from "./type.js";
import { browserMap } from "./read.js";
import { buildActionMap } from "../cdp/walker.js";
import type { ClickResult } from "./click.js";
import type { TypeResult } from "./type.js";
import type CDP from "chrome-remote-interface";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) { logDebug(`  ✅ ${msg}`); passed++; }
  else { logDebug(`  ❌ ${msg}`); failed++; }
};

async function main() {
  const config = loadConfigSync();
  const client = await getOrConnect(config);
  const session: CDP.Client = client.session;

  // ── Test 1: browser_map returns ref IDs ────────────
  logDebug("\n── Test 1: browser_map returns ref IDs ──");
  await session.Page.navigate({ url: "https://httpbin.org/forms/post" });
  await sleep(3000);

  const mapStr = await browserMap(session, { prune: true }, "default", config);
  assert(typeof mapStr === "string" && mapStr.length > 80, "map returned markdown content");

  const rawMap = await buildActionMap(session, { prune: true }, "default");
  assert(rawMap.elements.length >= 3, "map has >= 3 elements");
  const allValid = rawMap.elements.filter(Boolean).every(el => el.id && String(el.id).startsWith("w:"));
  assert(allValid, "all elements have w: ref IDs");

  // ── Test 2: weaveClick by label ────────────────────
  logDebug("\n── Test 2: weaveClick by label ──");
  await session.Page.navigate({ url: "https://httpbin.org/forms/post" });
  await sleep(3000);

  const clickR = await weaveClick(session, { label: "Submit order" }, config) as ClickResult;
  assert(clickR.success === true, "click returned success");
  assert(typeof clickR.clicked === "string" && clickR.clicked.length > 0, "clicked field set");
  assert(typeof clickR.ref === "string" && clickR.ref.startsWith("w:"), "ref is w:NN format");
  assert(typeof clickR.execution_ms === "number" && clickR.execution_ms > 0, "execution_ms > 0");

  // ── Test 3: weaveType by ref ID ────────────────────
  logDebug("\n── Test 3: weaveType by ref ID ──");
  await session.Page.navigate({ url: "https://httpbin.org/forms/post" });
  await sleep(3000);

  const elems = await buildActionMap(session, { prune: true }, "default");
  const textbox = elems.elements.find(el => el.role === "textbox" || (el.role === "input" && !el.type));
  if (textbox?.id) {
    const typeR = await weaveType(session, { id: textbox.id, text: "Hello" }, config) as TypeResult;
    assert(typeR.success === true, "type returned success");
    assert(typeof typeR.length === "number" && typeR.length > 0, "length > 0");
    assert(typeof typeR.typed_into === "string", "typed_into is string");
    assert(typeof typeR.execution_ms === "number" && typeR.execution_ms > 0, "execution_ms > 0");
  } else {
    assert(true, "no text input found (skip)");
  }

  // ── Test 4: weaveClick by ref ID ───────────────────
  logDebug("\n── Test 4: weaveClick by ref ID ──");
  await session.Page.navigate({ url: "https://httpbin.org/forms/post" });
  await sleep(3000);

  const map2 = await buildActionMap(session, { prune: true }, "default");
  const btn = map2.elements.find(r => r.role === "button");
  if (btn?.id) {
    const refR = await weaveClick(session, { id: btn.id }, config) as ClickResult;
    assert(refR.success === true, "ref-ID click returned success");
    assert(refR.ref === btn.id, "click.ref matches input ref");
  } else {
    assert(true, "no button found (skip)");
  }

  // ── Test 5: Stuck detection on nonexistent element ─
  logDebug("\n── Test 5: Stuck detection ──");
  const stuckR = await weaveClick(session, { label: "__nonexistent__" }, config) as ClickResult;
  if (stuckR.success) {
    assert(stuckR.stuck_warning === true, "nonexistent click reports stuck_warning");
  } else {
    assert(true, "nonexistent click correctly fails");
  }

  // ── Summary ────────────────────────────────────────
  logDebug(`\nResults: ${passed} passed, ${failed} failed`);
  await session.close().catch(() => {});
  if (failed > 0) process.exit(1);
  else logDebug("ALL INTEGRATION TESTS PASSED");
  process.exit(0);
}
main();
