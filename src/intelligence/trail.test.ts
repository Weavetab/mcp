/**
 * trail.test.ts — Phase 1.1
 * Unit tests ensuring resetLoopCounter does NOT wipe the trail and that loop
 * detection respects timestamp-based reset boundaries.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordAction,
  getTrail,
  clearTrail,
  getLoopDiagnostics,
  detectLoop,
  resetLoopCounter,
  resetLoopCounterForRef,
} from "./trail.js";

// Helper: record N consecutive failures for a given tool+ref
function recordFailures(tool: string, ref: string, count: number) {
  for (let i = 0; i < count; i++) {
    recordAction({
      timestamp: new Date().toISOString(),
      tool,
      input: { ref },
      result: { success: false, stuck: true },
    });
  }
}

// Helper: record one success
function recordSuccess(tool: string, ref: string) {
  recordAction({
    timestamp: new Date().toISOString(),
    tool,
    input: { ref },
    result: { success: true, stuck: false },
  });
}

test("trail: recordAction appends entries", () => {
  clearTrail();
  recordSuccess("browser_click", "w:1");
  assert.equal(getTrail().length, 1);
  clearTrail();
});

test("loop: no warning below threshold (< 5 strikes)", () => {
  clearTrail();
  recordFailures("browser_click", "w:99", 4);
  const diag = getLoopDiagnostics("browser_click", "w:99");
  assert.equal(diag.severity, "none", `Expected none at 4 strikes, got ${diag.severity}`);
  clearTrail();
});

test("loop: warning fires at ≥ 5 strikes (half of LOOP_LIMIT=10)", () => {
  clearTrail();
  recordFailures("browser_click", "w:99", 5);
  const diag = getLoopDiagnostics("browser_click", "w:99");
  assert.equal(diag.severity, "warning", `Expected warning at 5 strikes, got ${diag.severity}`);
  clearTrail();
});

test("loop: critical fires at ≥ 10 strikes", () => {
  clearTrail();
  recordFailures("browser_click", "w:99", 10);
  const diag = getLoopDiagnostics("browser_click", "w:99");
  assert.equal(diag.severity, "critical", `Expected critical at 10 strikes, got ${diag.severity}`);
  clearTrail();
});

test("loop: success resets the consecutive strike count", () => {
  clearTrail();
  recordFailures("browser_click", "w:5", 6);
  recordSuccess("browser_click", "w:5"); // interrupts the consecutive run
  const diag = getLoopDiagnostics("browser_click", "w:5");
  assert.equal(diag.strikes, 0, `Expected 0 strikes after success, got ${diag.strikes}`);
  clearTrail();
});

test("Phase 0.1: resetLoopCounter preserves trail history", () => {
  clearTrail();
  recordSuccess("browser_click", "w:1");
  recordSuccess("browser_type", "w:2");
  const countBefore = getTrail().length;
  assert.equal(countBefore, 2);

  resetLoopCounter("test");

  // Trail must still have the same entries — history is preserved
  const countAfter = getTrail().length;
  assert.equal(countAfter, 2, `Trail should still have 2 entries after resetLoopCounter, got ${countAfter}`);
  clearTrail();
});

test("Phase 0.1: resetLoopCounter clears strikes without wiping trail", () => {
  clearTrail();
  recordFailures("browser_click", "w:7", 10);
  const before = getLoopDiagnostics("browser_click", "w:7");
  assert.equal(before.severity, "critical");

  resetLoopCounter("test");

  // New failures recorded AFTER reset should count fresh
  recordFailures("browser_click", "w:7", 2);
  const after = getLoopDiagnostics("browser_click", "w:7");
  // Trail still has 12 entries but only 2 are after the reset boundary
  assert.equal(after.strikes, 2, `Expected 2 strikes post-reset, got ${after.strikes}`);
  assert.equal(after.severity, "none", `Expected none at 2 strikes post-reset, got ${after.severity}`);
  clearTrail();
});

test("Phase 0.1: resetLoopCounterForRef only affects that ref", () => {
  clearTrail();
  recordFailures("browser_click", "w:A", 10); // critical
  recordFailures("browser_click", "w:B", 10); // critical

  resetLoopCounterForRef("browser_click", "w:A");

  const diagA = getLoopDiagnostics("browser_click", "w:A");
  const diagB = getLoopDiagnostics("browser_click", "w:B");

  assert.equal(diagA.strikes, 0, `w:A should have 0 strikes after per-ref reset, got ${diagA.strikes}`);
  assert.equal(diagB.severity, "critical", `w:B should still be critical, got ${diagB.severity}`);
  clearTrail();
});

test("Phase 0.1: detectLoop returns false after resetLoopCounter", () => {
  clearTrail();
  recordFailures("browser_click", "w:X", 10);
  assert.equal(detectLoop("browser_click", "w:X"), true, "Expected loop before reset");

  resetLoopCounter("test");
  recordFailures("browser_click", "w:X", 3); // not enough for loop after reset

  assert.equal(detectLoop("browser_click", "w:X"), false, "Expected no loop after reset with only 3 new strikes");
  clearTrail();
});
