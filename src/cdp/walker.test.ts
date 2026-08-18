/**
 * walker.test.ts — Phase 1.1
 * Unit tests for walker.ts utility functions (no CDP session needed).
 * buildActionMap and buildAXTreeMap require live browser — not tested here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toRefEntries,
  findAllMatches,
  findBestMatch,
  toMarkdownTable,
  safeSelector,
  clearViewportCache,
  resetFallbackIdCounter,
  setShadowDomCache,
  clearShadowDomCache,
  clearAXTreeCache,
  resetFallbackIdCounter as resetIdCounter,
} from "./walker.js";
import type { ActionElement } from "./walker.js";

function makeEl(overrides: Partial<ActionElement> = {}): ActionElement {
  return {
    id: "w:1",
    role: "button",
    label: "Submit",
    group: "form",
    fingerprint: "button:submit:form:1",
    depth: 0,
    ...overrides,
  };
}

test("toRefEntries: converts ActionElements to RefEntries", () => {
  const els: ActionElement[] = [
    makeEl({ id: "w:1", label: "Sign In", role: "button", type: "submit", fingerprint: "a" }),
    makeEl({ id: "w:2", label: "Email", role: "textbox", type: "email", fingerprint: "b" }),
  ];
  const refs = toRefEntries(els);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].id, "w:1");
  assert.equal(refs[0].label, "Sign In");
  assert.equal(refs[0].type, "submit");
  assert.equal(refs[0].disabled, false);
  assert.equal(refs[1].id, "w:2");
});

test("toRefEntries: empty array returns empty", () => {
  assert.deepEqual(toRefEntries([]), []);
});

test("findAllMatches: exact label match", () => {
  const els = [
    makeEl({ id: "w:1", label: "Sign In" }),
    makeEl({ id: "w:2", label: "Sign Out" }),
    makeEl({ id: "w:3", label: "Email" }),
  ];
  const matches = findAllMatches(els, "Sign In");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "w:1");
});

test("findAllMatches: partial label match", () => {
  const els = [
    makeEl({ id: "w:1", label: "Sign In" }),
    makeEl({ id: "w:2", label: "Sign Out" }),
    makeEl({ id: "w:3", label: "Email" }),
  ];
  const matches = findAllMatches(els, "Sign");
  assert.equal(matches.length, 2);
  assert.ok(matches.find(m => m.id === "w:1"));
  assert.ok(matches.find(m => m.id === "w:2"));
});

test("findAllMatches: case insensitive", () => {
  const els = [makeEl({ id: "w:1", label: "SIGN IN" })];
  const matches = findAllMatches(els, "sign in");
  assert.equal(matches.length, 1);
});

test("findAllMatches: placeholder match", () => {
  const els = [makeEl({ id: "w:1", label: "", placeholder: "Enter name" })];
  const matches = findAllMatches(els, "Enter name");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "w:1");
});

test("findAllMatches: empty query returns empty", () => {
  const els = [makeEl({ id: "w:1", label: "Submit" })];
  assert.deepEqual(findAllMatches(els, ""), []);
  assert.deepEqual(findAllMatches(els, "  "), []);
  assert.deepEqual(findAllMatches(els, "\t"), []);
});

test("findAllMatches: fuzzy multi-word match", () => {
  const els = [
    makeEl({ id: "w:1", label: "Create New Account" }),
    makeEl({ id: "w:2", label: "Create Post" }),
  ];
  const matches = findAllMatches(els, "Create Account");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].id, "w:1");
});

test("findAllMatches: returns unique elements only", () => {
  const els = [makeEl({ id: "w:1", label: "Submit" })];
  // label and type both match "Submit"
  const matches = findAllMatches(els, "Submit");
  assert.equal(matches.length, 1);
});

test("findBestMatch: returns first match", () => {
  const els = [
    makeEl({ id: "w:1", label: "Sign In" }),
    makeEl({ id: "w:2", label: "Sign Out" }),
  ];
  const best = findBestMatch(els, "Sign");
  assert.ok(best);
  assert.equal(best.id, "w:1");
});

test("findBestMatch: undefined on no match", () => {
  assert.equal(findBestMatch([], "nonexistent"), undefined);
});

test("toMarkdownTable: basic formatting", () => {
  const els = [
    makeEl({ id: "w:1", label: "Submit", role: "button", depth: 0 }),
    makeEl({ id: "w:2", label: "Email", role: "textbox", depth: 0 }),
  ];
  const md = toMarkdownTable(els, "https://example.com", "Test Page");
  assert.ok(md.includes("https://example.com"));
  assert.ok(md.includes("Test Page"));
  assert.ok(md.includes("Submit"));
  assert.ok(md.includes("Email"));
  assert.ok(md.includes("(Btn)"));
  assert.ok(md.includes("(Input)"));
});

test("toMarkdownTable: respects depth indentation", () => {
  const els = [
    makeEl({ id: "w:1", label: "Root", role: "button", depth: 0 }),
    makeEl({ id: "w:2", label: "Child", role: "textbox", depth: 1 }),
  ];
  const md = toMarkdownTable(els, "https://x.com", "X");
  // child should be indented
  const lines = md.split("\n");
  const childLine = lines.find(l => l.includes("Child"));
  assert.ok(childLine, "Child line should exist");
  assert.ok(childLine.startsWith("  "), "Child should be indented");
});

test("toMarkdownTable: strips non-interactive elements without label", () => {
  const els = [
    makeEl({ id: "", label: "", role: "generic", depth: 0 }),
    makeEl({ id: "w:1", label: "Real", role: "button", depth: 0 }),
  ];
  const md = toMarkdownTable(els, "https://x.com", "X");
  assert.ok(!md.includes("generic"), "Empty generic should be stripped");
  assert.ok(md.includes("Real"));
});

test("safeSelector: returns selector when present", () => {
  const el = makeEl({ selector: "#submit-btn" });
  assert.equal(safeSelector(el), "#submit-btn");
});

test("safeSelector: returns undefined when no selector", () => {
  assert.equal(safeSelector(makeEl()), undefined);
});

test("safeSelector: returns undefined on undefined input", () => {
  assert.equal(safeSelector(undefined), undefined);
});

test("clearViewportCache: no-op smoke test", () => {
  clearViewportCache("test-target");
  assert.ok(true, "clearViewportCache should not throw");
});

test("resetFallbackIdCounter: no-op smoke test", () => {
  resetIdCounter();
  assert.ok(true, "resetFallbackIdCounter should not throw");
});

test("shadowDomCache: set and clear", () => {
  setShadowDomCache("target-a", true);
  setShadowDomCache("target-b", false);
  clearShadowDomCache("target-a");
  clearShadowDomCache("target-b");
  assert.ok(true, "shadowDomCache should not throw");
});

test("clearAXTreeCache: no-op smoke test", () => {
  clearAXTreeCache("any-target");
  assert.ok(true, "clearAXTreeCache should not throw");
});

test("findAllMatches: type match fallback", () => {
  const els = [
    makeEl({ id: "w:1", label: "", type: "checkbox" }),
    makeEl({ id: "w:2", label: "Checkbox", type: "text" }),
  ];
  const matches = findAllMatches(els, "checkbox");
  assert.equal(matches.length, 2);
});
