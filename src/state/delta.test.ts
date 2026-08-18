/**
 * delta.test.ts — Phase 1.1
 * Unit tests for snapshot diffing and delta computation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  storeSnapshot,
  computeDelta,
  seedRichSnapshot,
  computeRichDelta,
  clearSnapshot,
  clearAllSnapshots,
  type RefEntry,
  type ActionElement,
} from "./delta.js";

test("delta: first visit returns null (no baseline)", () => {
  const targetId = "tab-1";
  clearAllSnapshots();
  
  const refs: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", fingerprint: "button:submit:div:0" },
  ];
  
  const result = computeDelta(targetId, 'http://test.com', refs);
  assert.equal(result, null, "First visit should return null");
});

test("delta: detects added elements", () => {
  const targetId = "tab-2";
  clearAllSnapshots();
  
  const initial: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", fingerprint: "button:submit:div:0" },
  ];
  storeSnapshot(targetId, 'http://test.com', initial);
  
  const updated: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", fingerprint: "button:submit:div:0" },
    { id: "w:2", role: "link", label: "Home", fingerprint: "link:home:nav:1" },
  ];
  
  const result = computeDelta(targetId, 'http://test.com', updated);
  assert.ok(result !== null);
  assert.equal(result?.added.length, 1, "One element added");
  assert.equal(result?.added[0]?.id, "w:2");
  assert.equal(result?.removed.length, 0);
  assert.equal(result?.changed.length, 0);
});

test("delta: detects removed elements", () => {
  const targetId = "tab-3";
  clearAllSnapshots();
  
  const initial: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", fingerprint: "button:submit:div:0" },
    { id: "w:2", role: "link", label: "Home", fingerprint: "link:home:nav:1" },
  ];
  storeSnapshot(targetId, 'http://test.com', initial);
  
  const updated: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", fingerprint: "button:submit:div:0" },
  ];
  
  const result = computeDelta(targetId, 'http://test.com', updated);
  assert.ok(result !== null);
  assert.equal(result?.added.length, 0);
  assert.equal(result?.removed.length, 1, "One element removed");
  assert.equal(result?.removed[0], "w:2");
  assert.equal(result?.changed.length, 0);
});

test("delta: detects changed elements (label)", () => {
  const targetId = "tab-4";
  clearAllSnapshots();
  
  const initial: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", fingerprint: "button:submit:div:0" },
  ];
  storeSnapshot(targetId, 'http://test.com', initial);
  
  const updated: RefEntry[] = [
    { id: "w:1", role: "button", label: "Cancel", fingerprint: "button:cancel:div:0" },
  ];
  
  const result = computeDelta(targetId, 'http://test.com', updated);
  assert.ok(result !== null);
  assert.equal(result?.added.length, 0);
  assert.equal(result?.removed.length, 0);
  assert.equal(result?.changed.length, 1, "One element changed");
  assert.equal(result?.changed[0]?.id, "w:1");
  assert.equal(result?.changed[0]?.label, "Cancel");
});

test("delta: detects changed elements (disabled)", () => {
  const targetId = "tab-5";
  clearAllSnapshots();
  
  const initial: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", disabled: false, fingerprint: "button:submit:div:0" },
  ];
  storeSnapshot(targetId, 'http://test.com', initial);
  
  const updated: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", disabled: true, fingerprint: "button:submit:div:0" },
  ];
  
  const result = computeDelta(targetId, 'http://test.com', updated);
  assert.ok(result !== null);
  assert.equal(result?.changed.length, 1, "Disabled state change detected");
  assert.equal(result?.changed[0]?.disabled, true);
});

test("delta: detects changed elements (value)", () => {
  const targetId = "tab-6";
  clearAllSnapshots();
  
  const initial: RefEntry[] = [
    { id: "w:1", role: "textbox", label: "Email", value: "", fingerprint: "textbox:email:form:0" },
  ];
  storeSnapshot(targetId, 'http://test.com', initial);
  
  const updated: RefEntry[] = [
    { id: "w:1", role: "textbox", label: "Email", value: "test@example.com", fingerprint: "textbox:email:form:0" },
  ];
  
  const result = computeDelta(targetId, 'http://test.com', updated);
  assert.ok(result !== null);
  assert.equal(result?.changed.length, 1, "Value change detected");
  assert.equal(result?.changed[0]?.value, "test@example.com");
});

test("delta: counts stable elements", () => {
  const targetId = "tab-7";
  clearAllSnapshots();
  
  const initial: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", fingerprint: "button:submit:div:0" },
    { id: "w:2", role: "link", label: "Home", fingerprint: "link:home:nav:1" },
    { id: "w:3", role: "textbox", label: "Email", fingerprint: "textbox:email:form:0" },
  ];
  storeSnapshot(targetId, 'http://test.com', initial);
  
  const updated: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", fingerprint: "button:submit:div:0" },
    { id: "w:2", role: "link", label: "Home", fingerprint: "link:home:nav:1" },
    { id: "w:3", role: "textbox", label: "Email", value: "test@example.com", fingerprint: "textbox:email:form:0" },
  ];
  
  const result = computeDelta(targetId, 'http://test.com', updated);
  assert.ok(result !== null);
  assert.equal(result?.stable_count, 2, "Two stable elements");
  assert.equal(result?.changed.length, 1);
});

test("delta: updates stored snapshot", () => {
  const targetId = "tab-8";
  clearAllSnapshots();
  
  const initial: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", fingerprint: "button:submit:div:0" },
  ];
  storeSnapshot(targetId, 'http://test.com', initial);
  
  const updated: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", fingerprint: "button:submit:div:0" },
    { id: "w:2", role: "link", label: "Home", fingerprint: "link:home:nav:1" },
  ];
  
  computeDelta(targetId, 'http://test.com', updated);
  
  // Second call should see no changes since snapshot was updated
  const secondCall = computeDelta(targetId, 'http://test.com', updated);
  assert.ok(secondCall !== null);
  assert.equal(secondCall?.added.length, 0);
  assert.equal(secondCall?.removed.length, 0);
  assert.equal(secondCall?.changed.length, 0);
  assert.equal(secondCall?.stable_count, 2);
});

test("delta: rich delta - first visit returns null", async () => {
  const targetId = "tab-9";
  clearAllSnapshots();
  
  const elements: ActionElement[] = [
    { id: "w:1", role: "button", label: "Submit", fingerprint: "button:submit:div:0", group: "utility", depth: 0 } as any,
  ];
  
  const result = await computeRichDelta(targetId, 'http://test.com', elements);
  assert.equal(result, null, "First visit rich delta returns null");
});

test("delta: rich delta - basic changed properties", async () => {
  const targetId = "tab-10";
  clearAllSnapshots();
  
  const initial: ActionElement[] = [
    { 
      id: "w:1", 
      role: "button", 
      label: "Submit", 
      value: "",
      disabled: false,
      fingerprint: "button:submit:div:0",
      group: "utility",
      depth: 0 
    } as any,
  ];
  
  // Seed the snapshot first
  seedRichSnapshot(targetId, 'http://test.com', initial);
  
  const updated: ActionElement[] = [
    { 
      id: "w:1", 
      role: "button", 
      label: "Submit", 
      value: "",
      disabled: true,
      fingerprint: "button:submit:div:0",
      group: "utility",
      depth: 0 
    } as any,
  ];
  
  const result = await computeRichDelta(targetId, 'http://test.com', updated);
  assert.ok(result !== null);
  assert.ok(!("delta_timeout" in result));
  const diff = result as any;
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0]?.ref, "w:1");
  assert.ok("disabled" in diff.changed[0]?.changes);
  assert.equal(diff.changed[0]?.changes?.disabled?.from, "false");
  assert.equal(diff.changed[0]?.changes?.disabled?.to, "true");
});

test("delta: rich delta - marks interactive elements as actionable", async () => {
  const targetId = "tab-11";
  clearAllSnapshots();
  
  const initial: ActionElement[] = [
    { 
      id: "w:1", 
      role: "button", 
      label: "Submit",
      fingerprint: "button:submit:div:0",
      group: "utility",
      depth: 0 
    } as any,
  ];
  
  // Seed the snapshot first
  seedRichSnapshot(targetId, 'http://test.com', initial);
  
  const updated: ActionElement[] = [
    { 
      id: "w:1", 
      role: "button", 
      label: "Submit",
      value: "",
      disabled: false, // Changed from undefined/missing to false
      fingerprint: "button:submit:div:0",
      group: "utility",
      depth: 0 
    } as any,
  ];
  
  const result = await computeRichDelta(targetId, 'http://test.com', updated);
  assert.ok(result !== null);
  assert.ok(!("delta_timeout" in result));
  const diff = result as any;
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0]?.actionable, true);
  assert.equal(diff.changed[0]?.recommended_action, "click");
});

test("delta: rich delta - iframe tracking", async () => {
  const targetId = "tab-12";
  clearAllSnapshots();
  
  const initial: ActionElement[] = [
    { 
      id: "w:1", 
      role: "button", 
      label: "Submit",
      frameUrl: "https://example.com",
      fingerprint: "button:submit:div:0",
      group: "utility",
      depth: 0 
    } as any,
  ];
  
  // Seed the snapshot first
  seedRichSnapshot(targetId, 'http://test.com', initial);
  
  const updated: ActionElement[] = [
    { 
      id: "w:1", 
      role: "button", 
      label: "Submit",
      frameUrl: "https://example.com",
      fingerprint: "button:submit:div:0",
      group: "utility",
      depth: 0 
    } as any,
    { 
      id: "w:2", 
      role: "link", 
      label: "Home",
      frameUrl: "https://iframe.com",
      fingerprint: "link:home:nav:1",
      group: "navigation",
      depth: 1 
    } as any,
  ];
  
  const result = await computeRichDelta(targetId, 'http://test.com', updated);
  assert.ok(result !== null);
  assert.ok(!("delta_timeout" in result));
  const diff = result as any;
  assert.ok(diff.iframes !== undefined);
  assert.equal(diff.iframes?.length, 1);
  assert.equal(diff.iframes?.[0]?.status, "added");
  assert.equal(diff.iframes?.[0]?.frameUrl, "https://iframe.com");
});

test("delta: clearSnapshot removes all data", () => {
  const targetId = "tab-13";
  const refs: RefEntry[] = [
    { id: "w:1", role: "button", label: "Submit", fingerprint: "button:submit:div:0" },
  ];
  
  storeSnapshot(targetId, 'http://test.com', refs);
  seedRichSnapshot(targetId, 'http://test.com', [] as any);
  
  clearAllSnapshots();
  
  const result = computeDelta(targetId, 'http://test.com', refs);
  assert.equal(result, null, "Cache cleared");
});
