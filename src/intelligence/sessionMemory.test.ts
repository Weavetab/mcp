/**
 * sessionMemory.test.ts — Phase 1.1
 * Integrated into node:test runner (npm test / npm run test:unit).
 * Previously a manual runTests() script; ported to node:test format.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import {
  getBestSelectorForIntent,
  logMemorySuccess,
  logMemoryFailure,
  loadDomainProfile,
} from "./sessionMemory.js";
import { getSystemDir } from "../config/loader.js";

const hostname = "test.weavetab.pages.dev";
let profilePath: string;

before(() => {
  const memoryDir = getSystemDir("memory");
  profilePath = path.join(memoryDir, `${hostname}.json`);
  if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
});

after(() => {
  if (fs.existsSync(profilePath)) fs.unlinkSync(profilePath);
});

test("1: Initial success log — selector is immediately retrievable", async () => {
  await logMemorySuccess(hostname, "Click Login", ".login-btn", { role: "button", tag: "button" });
  const sel = await getBestSelectorForIntent(hostname, "Click Login");
  assert.equal(sel?.selector, ".login-btn", `Expected .login-btn, got ${sel?.selector}`);
});

test("2: Dead selector (first strike) — score drops below threshold", async () => {
  // Simulate visit count increment
  const profile = await loadDomainProfile(hostname);
  profile!.visitCount++;
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

  await logMemoryFailure(hostname, "Click Login", ".login-btn", "DEAD_SELECTOR");
  const sel = await getBestSelectorForIntent(hostname, "Click Login");
  assert.equal(sel, undefined, "Expected undefined — score dropped below 0.5 threshold after one failure");
});

test("3: Dead selector recovery — new successful selector wins", async () => {
  await logMemorySuccess(hostname, "Click Login", "#login-new", { role: "button", tag: "button" });
  const sel = await getBestSelectorForIntent(hostname, "Click Login");
  assert.equal(sel?.selector, "#login-new", `Expected #login-new, got ${sel?.selector}`);
});

test("4: Decay check — both old and new memory entries exist in profile", async () => {
  const profile = await loadDomainProfile(hostname);
  const oldMem = profile!.memories.find(m => m.selector === ".login-btn");
  const newMem = profile!.memories.find(m => m.selector === "#login-new");
  assert.ok(oldMem !== undefined, "Expected old memory (.login-btn) to still exist");
  assert.ok(newMem !== undefined, "Expected new memory (#login-new) to exist");
});

test("5: Negative memory expiration — both selectors decay below threshold after many visits", async () => {
  const profile = await loadDomainProfile(hostname);
  const inFailed = profile!.failedSelectors.find(f => f.selector === ".login-btn");
  assert.ok(inFailed !== undefined, "Expected .login-btn in failedSelectors after DEAD_SELECTOR strike");

  // Advance visits far past expiration window (expiration = visitCount + 10).
  // After +15 visits, DecayFactor drops to ~0.25, pulling #login-new below 0.5 threshold too.
  profile!.visitCount += 15;
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

  // Both selectors are now expired / decayed — correct behavior is a miss (force DOM re-resolution)
  const sel = await getBestSelectorForIntent(hostname, "Click Login");
  assert.equal(sel, undefined, "Expected undefined after extreme visit-count decay — selectors should re-confirm via DOM");
});
