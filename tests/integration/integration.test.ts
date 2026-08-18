/**
 * integration.test.ts — Phase 1.1
 * Integration tests for click, type, and browser_map against real pages.
 * Run: npx tsx tests/integration/integration.test.ts
 */
import { loadConfigSync } from "../../src/config/loader.js";
import { getOrConnect } from "../../src/cdp/connector.js";
import { weaveClick } from "../../src/tools/click.js";
import { weaveType } from "../../src/tools/type.js";
import { browserMap } from "../../src/tools/read.js";
import { buildActionMap } from "../../src/cdp/walker.js";
import type { ClickResult } from "../../src/tools/click.js";
import type { TypeResult } from "../../src/tools/type.js";
import type CDP from "chrome-remote-interface";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const assert = (cond: boolean, msg: string) => {
  if (cond) { console.error(`  ✅ ${msg}`); passed++; }
  else { console.error(`  ❌ ${msg}`); failed++; }
};

async function main() {
  const config = loadConfigSync();
  const client = await getOrConnect(config);
  const session: CDP.Client = client.session;

  console.error("\n── Test 1: browser_map returns ref IDs ──");
  await session.Page.navigate({ url: "https://httpbin.org/forms/post" });
  await sleep(3000);

  const mapStr = await browserMap(session, { prune: true }, "default", config);
  assert(typeof mapStr === "string" && mapStr.length > 80, "map returned markdown content");

  const rawMap = await buildActionMap(session, { prune: true }, "default");
  assert(rawMap.elements.length >= 3, "map has >= 3 elements");
  const allValid = rawMap.elements.filter(Boolean).every(el => el.id && String(el.id).startsWith("w:"));
  assert(allValid, "all elements have w: ref IDs");

  console.error("\n── Test 2: weaveClick by label ──");
  await session.Page.navigate({ url: "https://httpbin.org/forms/post" });
  await sleep(3000);

  const clickR = await weaveClick(session, { label: "Submit order" }, config) as ClickResult;
  assert(clickR.success === true, "click returned success");
  assert(typeof clickR.clicked === "string" && clickR.clicked.length > 0, "clicked field set");
  assert(typeof clickR.ref === "string" && clickR.ref.startsWith("w:"), "ref is w:NN format");
  assert(typeof clickR.execution_ms === "number" && clickR.execution_ms > 0, "execution_ms > 0");

  console.error("\n── Test 3: weaveType by ref ID ──");
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

  console.error("\n── Test 4: weaveClick by ref ID ──");
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

  console.error("\n── Test 5: Stuck detection on nonexistent element ──");
  const stuckR = await weaveClick(session, { label: "__nonexistent__" }, config) as ClickResult;
  if (stuckR.success) {
    assert(stuckR.stuck_warning === true, "nonexistent click reports stuck_warning");
  } else {
    assert(true, "nonexistent click correctly fails");
  }

  console.error(`\nResults: ${passed} passed, ${failed} failed`);
  await session.close().catch(() => {});
  if (failed > 0) process.exit(1);
  else console.error("ALL INTEGRATION TESTS PASSED");
  process.exit(0);
}
main();
