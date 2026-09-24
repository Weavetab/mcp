import test from "node:test";
import assert from "node:assert";
import { browserBurst, compileTraceToMacro } from "../../src/tools/burst.js";
import { recordAction, clearTrail } from "../../src/intelligence/trail.js";

test("compileTraceToMacro compiles valid action trail", () => {
  const steps = [
    {
      sessionId: "test-sess",
      timestamp: new Date().toISOString(),
      tool: "browser_navigate",
      input: { url: "https://example.com" },
      result: { success: true },
    },
    {
      sessionId: "test-sess",
      timestamp: new Date().toISOString(),
      tool: "browser_map",
      input: { lite: true },
      result: { success: true },
    },
    {
      sessionId: "test-sess",
      timestamp: new Date().toISOString(),
      tool: "browser_fill",
      input: { ref: "w:10", value: "admin" },
      result: { success: true },
    },
    {
      sessionId: "test-sess",
      timestamp: new Date().toISOString(),
      tool: "browser_click",
      input: { ref: "w:12" },
      result: { success: false, error: "occluded" },
    },
    {
      sessionId: "test-sess",
      timestamp: new Date().toISOString(),
      tool: "browser_click",
      input: { ref: "w:12" },
      result: { success: true },
    },
    {
      sessionId: "test-sess",
      timestamp: new Date().toISOString(),
      tool: "browser_map",
      input: { lite: true },
      result: { success: true },
    },
  ];

  const macro = compileTraceToMacro(steps as any);
  assert.equal(macro.length, 4, "Should have navigate, fill, click, and final map");
  assert.equal(macro[0]!.tool, "browser_navigate");
  assert.equal(macro[1]!.tool, "browser_fill");
  assert.equal(macro[2]!.tool, "browser_click");
  assert.equal(macro[3]!.tool, "browser_map");
});

test("compileTraceToMacro dedupes consecutive identical steps", () => {
  const steps = [
    {
      sessionId: "s",
      timestamp: "t1",
      tool: "browser_wait",
      input: { duration: 100 },
      result: { success: true },
    },
    {
      sessionId: "s",
      timestamp: "t2",
      tool: "browser_wait",
      input: { duration: 100 },
      result: { success: true },
    },
  ];

  const macro = compileTraceToMacro(steps as any);
  assert.equal(macro.length, 1, "Duplicate wait steps should be deduped");
});

test("browserBurst - dry_run compile_from_history returns compiled steps", async () => {
  clearTrail();
  recordAction({
    timestamp: new Date().toISOString(),
    tool: "browser_fill",
    input: { ref: "w:5", value: "query" },
    result: { success: true },
  });

  const sessionMock: any = {};
  const configMock: any = {};

  const res = await browserBurst(
    sessionMock,
    { compile_from_history: true, dry_run: true },
    configMock
  );

  assert.equal(res.success, true);
  assert.equal(res.steps_completed, 0);
  assert.ok(Array.isArray(res.compiled_steps));
  assert.equal(res.compiled_steps.length, 1);
  assert.equal(res.compiled_steps[0]!.tool, "browser_fill");
});

test("browserBurst - handles empty input safely", async () => {
  const sessionMock: any = {};
  const configMock: any = {};

  const res = await browserBurst(sessionMock, {}, configMock);
  assert.equal(res.success, true);
  assert.equal(res.steps_completed, 0);
  assert.equal(res.results.length, 0);
});
