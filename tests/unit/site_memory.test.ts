/**
 * site_memory.test.ts — Move 5 Intelligent Memory & Learning Engine
 * Tests for persistent SiteProfiles, pattern compilation, 3-strike degradation,
 * and anti-spam/anti-duplication guarantees in ~/.weavetab-system/memory/sites/.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { getSystemMemorySitesDir } from "../../src/config/loader.js";
import {
  getSiteProfile,
  saveSiteProfile,
  learnPattern,
  recordPatternExecution,
  recordQuirk,
  getPatternReliability,
  formatSiteProfileHint,
  clearSiteProfileCache,
} from "../../src/intelligence/patternCompiler.js";

const testOrigin = "https://unit-test.example.com";
const sitesDir = getSystemMemorySitesDir();
const expectedFile = path.join(sitesDir, "unit-test.example.com.json");

before(() => {
  clearSiteProfileCache();
  if (fs.existsSync(expectedFile)) fs.unlinkSync(expectedFile);
});

after(() => {
  clearSiteProfileCache();
  if (fs.existsSync(expectedFile)) fs.unlinkSync(expectedFile);
});

test("1: getSiteProfile returns null for unknown origin", async () => {
  const profile = await getSiteProfile("https://nonexistent-site-xyz.org");
  assert.equal(profile, null);
});

test("2: learnPattern creates SiteProfile file under ~/.weavetab-system/memory/sites/", async () => {
  const pattern = await learnPattern(testOrigin, "login_flow", {
    steps: [
      { tool: "browser_navigate", target: "https://unit-test.example.com/login" },
      { tool: "browser_fill", target: "#username", value: "testuser" },
      { tool: "browser_fill", target: "#password", value: "secret" },
      { tool: "browser_click", target: "button[type='submit']" },
    ],
    success_indicator: "a[aria-label='Dashboard']",
    entry: "/login",
  });

  assert.equal(pattern.name, "login_flow");
  assert.equal(pattern.steps.length, 4);
  assert.equal(pattern.reliability, 1.0);
  assert.equal(pattern.strikes, 0);

  assert.ok(fs.existsSync(expectedFile), `Expected file at ${expectedFile}`);
  const diskProfile = JSON.parse(fs.readFileSync(expectedFile, "utf-8"));
  assert.equal(diskProfile.origin, testOrigin);
  assert.ok(diskProfile.patterns.login_flow !== undefined);
});

test("3: Volatile selectors are filtered/stabilized from steps", async () => {
  const pattern = await learnPattern(testOrigin, "flaky_flow", {
    steps: [
      { tool: "browser_click", target: "div > div > div > span" }, // volatile deep chain
      { tool: "browser_click", target: "#stable-id" },              // stable
    ],
  });

  assert.equal(pattern.steps[0].target, undefined, "Volatile selector should be stripped");
  assert.equal(pattern.steps[1].target, "#stable-id", "Stable selector should be preserved");
});

test("4: Updating existing pattern does NOT duplicate files or add duplicate patterns", async () => {
  const filesBefore = fs.readdirSync(sitesDir).filter(f => f.includes("unit-test.example.com"));
  assert.equal(filesBefore.length, 1);

  await learnPattern(testOrigin, "login_flow", {
    success_indicator: "div.logged-in-badge",
  });

  const filesAfter = fs.readdirSync(sitesDir).filter(f => f.includes("unit-test.example.com"));
  assert.equal(filesAfter.length, 1, "Should still be exactly one file for this origin");

  const profile = await getSiteProfile(testOrigin);
  assert.ok(profile !== null);
  assert.equal(Object.keys(profile.patterns).length, 2); // login_flow + flaky_flow
  assert.equal(profile.patterns.login_flow.success_indicator, "div.logged-in-badge");
});

test("5: Anti-spam skips disk write if pattern is unchanged", async () => {
  const statBefore = fs.statSync(expectedFile);

  // Sleep slightly to ensure mtime would differ if written
  await new Promise(r => setTimeout(r, 50));
  await learnPattern(testOrigin, "login_flow", {});

  const statAfter = fs.statSync(expectedFile);
  assert.equal(statBefore.mtimeMs, statAfter.mtimeMs, "File should not be modified when data is identical");
});

test("6: recordPatternExecution tracks successes and updates reliability", async () => {
  const updated = await recordPatternExecution(testOrigin, "login_flow", true, 2500);
  assert.ok(updated !== null);
  assert.equal(updated.total_executions, 1);
  assert.equal(updated.successful_executions, 1);
  assert.equal(updated.strikes, 0);
  assert.equal(updated.avg_duration_ms, 2500);
  assert.ok(updated.reliability > 0.9);
});

test("7: 3-strike degradation drops reliability and warns", async () => {
  // Execute failure 1
  await recordPatternExecution(testOrigin, "login_flow", false);
  let p = (await getSiteProfile(testOrigin))!.patterns.login_flow;
  assert.equal(p.strikes, 1);

  // Execute failure 2
  await recordPatternExecution(testOrigin, "login_flow", false);
  p = (await getSiteProfile(testOrigin))!.patterns.login_flow;
  assert.equal(p.strikes, 2);

  // Execute failure 3
  await recordPatternExecution(testOrigin, "login_flow", false);
  p = (await getSiteProfile(testOrigin))!.patterns.login_flow;
  assert.equal(p.strikes, 3);
  assert.ok(p.reliability < 0.7, `Reliability should drop significantly, got ${p.reliability}`);

  // getPatternReliability returns updated score
  const rel = await getPatternReliability(testOrigin, "login_flow");
  assert.equal(rel, p.reliability);
});

test("8: recordQuirk persists site quirks (cookie_banner, rate_limit)", async () => {
  await recordQuirk(testOrigin, "cookie_banner", {
    selector: "#cookie-consent",
    action: "click .accept-all",
    appears: "first_visit",
  });

  const profile = await getSiteProfile(testOrigin);
  assert.ok(profile?.quirks.cookie_banner !== undefined);
  assert.equal((profile.quirks.cookie_banner as any).selector, "#cookie-consent");
});

test("9: formatSiteProfileHint generates compact hint for agent prompts", async () => {
  const profile = await getSiteProfile(testOrigin);
  assert.ok(profile !== null);
  profile.framework = "react";

  const hint = formatSiteProfileHint(profile);
  assert.ok(hint.includes(`[SiteProfile] ${testOrigin}`));
  assert.ok(hint.includes("framework: react"));
  assert.ok(hint.includes("login_flow"));
  assert.ok(hint.includes("cookie_banner"));
  assert.ok(hint.includes("[RE-LEARN NEEDED]"), "Should flag pattern with strikes >= 3");
});
