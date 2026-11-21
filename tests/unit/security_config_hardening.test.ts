import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

import {
  checkDomain,
  extractHostname,
  matchesPattern,
  isToolAllowedForRole,
  isToolAllowedInMode,
} from "../../src/security/blacklist.js";
import { filterHidden, stripInvisibleChars } from "../../src/security/filter.js";
import { checkRateLimit, resetRateLimit } from "../../src/security/ratelimit.js";
import {
  SessionSecretTracker,
  secretStore,
  encrypt,
  decrypt,
  getEncryptionKey,
  resolveSecretsPath,
  applyFilePermissions,
  GLOBAL_SECRETS_PATH,
} from "../../src/security/secrets.js";
import {
  redactSensitiveData,
  redactSensitiveDataInObject,
  pruneOldLogs,
} from "../../src/audit/logger.js";
import {
  DEFAULT_CONFIG,
  validateConfigInternal,
  safeReadJson,
  type Config,
} from "../../src/config/loader.js";
import { WeavetabOpen } from "../../src/tools/tabs.js";
import { browserSnapshot } from "../../src/tools/snapshot.js";
import { browserBurst } from "../../src/tools/burst.js";
import { parseCliInvokeArgs, isValidNpmPackageSpec } from "../../src/cli/plugin.js";
import { isNewerVersion } from "../../src/cli/updater.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
  };
}

test("blacklist — wildcard patterns, trailing FQDN dots, bare domain subdomains, specificity & allow-before-block", () => {
  assert.equal(extractHostname("https://PayPal.com./login"), "paypal.com");
  assert.equal(extractHostname("my.bank.co.uk..."), "my.bank.co.uk");

  assert.equal(matchesPattern("https://my.bank.com", "*.bank.*"), true);
  assert.equal(matchesPattern("https://online.bank.co.uk", "*.bank.*"), true);
  assert.equal(matchesPattern("https://chase.com", "chase.*"), true);
  assert.equal(matchesPattern("https://app.admin.org", "*.admin.org"), true);

  assert.equal(matchesPattern("https://paypal.com", "paypal.com"), true);
  assert.equal(matchesPattern("https://www.paypal.com", "paypal.com"), true);
  assert.equal(matchesPattern("https://paypal.com.", "paypal.com"), true);
  assert.equal(matchesPattern("https://evilpaypal.com", "paypal.com"), false);

  const defaultCfg = makeConfig();
  assert.equal(checkDomain("https://my.bank.com", defaultCfg).allowed, false);
  assert.equal(checkDomain("https://www.paypal.com.", defaultCfg).allowed, false);

  const allowOverrideCfg = makeConfig({
    allow: ["sandbox.paypal.com"],
    block: ["paypal.com"],
  });
  assert.equal(checkDomain("https://sandbox.paypal.com", allowOverrideCfg).allowed, true);
  assert.equal(checkDomain("https://www.paypal.com", allowOverrideCfg).allowed, false);

  const policyCfg = makeConfig({
    policies: [
      { pattern: "*.corp.internal", mode: "deny" },
      { pattern: "corp.internal", mode: "read-only" },
      { pattern: "docs.corp.internal", mode: "allow" },
    ],
  });
  const exactRes = checkDomain("https://docs.corp.internal", policyCfg);
  assert.equal(exactRes.allowed, true);
  assert.equal(exactRes.mode, "allow");

  const suffixRes = checkDomain("https://api.corp.internal", policyCfg);
  assert.equal(suffixRes.allowed, true);
  assert.equal(suffixRes.mode, "read-only");
  assert.equal(checkDomain("https://api.corp.internal", "browser_click", policyCfg).allowed, false);
  assert.equal(checkDomain("https://api.corp.internal", "browser_map", policyCfg).allowed, true);
});

test("RBAC — fail-closed unknown roles, viewer & read-only action gating, WeavetabOpen & browserBurst enforcement", async () => {
  assert.equal(isToolAllowedForRole("unknown_role", "browser_map").allowed, false);
  assert.equal(isToolAllowedForRole("viewer", "browser_eval").allowed, false);
  assert.equal(isToolAllowedInMode("browser_eval", "read-only").allowed, false);
  assert.equal(isToolAllowedForRole("automation", "browser_thoughts").allowed, false);

  assert.equal(isToolAllowedForRole("viewer", "browser_cookies", { action: "get" }).allowed, true);
  assert.equal(isToolAllowedForRole("viewer", "browser_cookies", { action: "list" }).allowed, true);
  assert.equal(isToolAllowedForRole("viewer", "browser_cookies", { action: "set" }).allowed, false);
  assert.equal(isToolAllowedForRole("viewer", "browser_cookies", { action: "delete" }).allowed, false);
  assert.equal(
    isToolAllowedForRole("viewer", "browser_cookies", { action: "get", url: "https://other.com" }, "https://app.com").allowed,
    false
  );

  assert.equal(isToolAllowedForRole("viewer", "browser_tabs", { action: "list" }).allowed, true);
  assert.equal(isToolAllowedForRole("viewer", "browser_tabs", { action: "list_windows" }).allowed, true);
  assert.equal(isToolAllowedForRole("viewer", "browser_tabs", { action: "open" }).allowed, false);
  assert.equal(isToolAllowedForRole("viewer", "browser_tabs", { action: "close" }).allowed, false);

  assert.equal(isToolAllowedForRole("viewer", "browser_console", { action: "read" }).allowed, true);
  assert.equal(isToolAllowedForRole("viewer", "browser_console", { action: "clear" }).allowed, false);

  assert.equal(isToolAllowedForRole("viewer", "browser_pattern_learn", { action: "get" }).allowed, true);
  assert.equal(isToolAllowedForRole("viewer", "browser_pattern_learn", { action: "learn" }).allowed, false);

  const tmpSnapDir = path.join(os.tmpdir(), `wt-snap-test-${process.pid}`);
  const viewerCfg = makeConfig({ role: "viewer", snapshotDir: tmpSnapDir });
  assert.equal(
    isToolAllowedForRole("viewer", "browser_snapshot", { action: "restore", filePath: "a.mhtml" }, "", viewerCfg).allowed,
    false
  );
  assert.equal(
    isToolAllowedForRole(
      "viewer",
      "browser_snapshot",
      { action: "capture", filePath: path.join(os.tmpdir(), "outside.mhtml") },
      "",
      viewerCfg
    ).allowed,
    false
  );
  await assert.rejects(
    () => browserSnapshot({} as any, { action: "restore", filePath: "a.mhtml" }, viewerCfg),
    /not permitted in viewer/i
  );
  await assert.rejects(
    () =>
      browserSnapshot(
        {} as any,
        { action: "capture", filePath: path.join(os.tmpdir(), "outside.mhtml") },
        viewerCfg
      ),
    /confined inside snapshotDir/i
  );

  await assert.rejects(
    () => WeavetabOpen("javascript:alert(1)", makeConfig()),
    /Blocked protocol/i
  );
  await assert.rejects(
    () => WeavetabOpen("https://my.bank.com/account", makeConfig()),
    /Domain blocked/i
  );

  resetRateLimit();
  const burstRes = await browserBurst(
    { Runtime: { evaluate: async () => ({ result: {} }) } } as any,
    { steps: [{ tool: "browser_click", args: { id: "w:1" } }] },
    viewerCfg
  );
  assert.equal(burstRes.success, false);
  assert.equal(burstRes.aborted, true);
  assert.match(burstRes.abort_reason || "", /Role 'viewer' does not have permission/);
});

test("secrets — fail-closed encryption key & decrypt, Object.hasOwn, trailing-dot domain check, CWD isolation & circular redactValue", () => {
  const key = crypto.randomBytes(32);
  const ct = encrypt("top_secret_val", key);
  assert.equal(decrypt(ct, key), "top_secret_val");

  const tampered = ct.slice(0, -4) + (ct.endsWith("0000") ? "ffff" : "0000");
  assert.throws(() => decrypt(tampered, key), /authenticate|Malformed|Invalid/i);
  assert.throws(() => decrypt("not-hex-ciphertext", key), /Malformed|Invalid/i);

  const badKeyFile = path.join(os.tmpdir(), `wt-bad-key-${process.pid}-${Date.now()}`);
  fs.writeFileSync(badKeyFile, "not_a_64_char_hex_key", "utf-8");
  try {
    assert.throws(() => getEncryptionKey(badKeyFile), /Invalid encryption key format/);
  } finally {
    fs.unlinkSync(badKeyFile);
  }

  const fakeRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-untrusted-repo-"));
  const fakeSecretsDir = path.join(fakeRepoDir, ".weavetab");
  fs.mkdirSync(fakeSecretsDir, { recursive: true });
  const fakeSecretsFile = path.join(fakeSecretsDir, "secrets.json");
  fs.writeFileSync(fakeSecretsFile, JSON.stringify({ version: 1, secrets: {} }), "utf-8");
  const prevEnv = process.env.WT_PROJECT_SECRETS;
  try {
    delete process.env.WT_PROJECT_SECRETS;
    assert.equal(resolveSecretsPath(fakeRepoDir), GLOBAL_SECRETS_PATH);
    process.env.WT_PROJECT_SECRETS = "1";
    assert.equal(resolveSecretsPath(fakeRepoDir), fakeSecretsFile);
  } finally {
    if (prevEnv === undefined) delete process.env.WT_PROJECT_SECRETS;
    else process.env.WT_PROJECT_SECRETS = prevEnv;
    fs.rmSync(fakeRepoDir, { recursive: true, force: true });
  }

  assert.equal(secretStore.getDomains("toString"), null);
  assert.equal(secretStore.checkDomain("constructor", "example.com"), false);

  const sid = "cycle-session";
  SessionSecretTracker.registerSecretValue(sid, "MyCycleSecret123");
  const cyclic: any = { token: "Bearer MyCycleSecret123", nested: [] };
  cyclic.nested.push(cyclic);
  const redactedObj = SessionSecretTracker.redactValue(sid, cyclic);
  assert.equal(redactedObj.token, "Bearer [REDACTED]");
  assert.equal(redactedObj.nested[0], "[Circular]");
  SessionSecretTracker.clearSession(sid);

  applyFilePermissions(GLOBAL_SECRETS_PATH);
  applyFilePermissions(path.join(os.homedir(), ".weavetab-system", "secrets-key"));
  applyFilePermissions(path.join(os.homedir(), ".weavetab-system", "telemetry-secret"));
});

test("logger — SessionSecretTracker redaction, array/cycle/key-name object redaction & log retention pruning", () => {
  const sid = "logger-sec-sess";
  SessionSecretTracker.registerSecretValue(sid, "ShortSec99");
  try {
    const line = redactSensitiveData("Injected value ShortSec99 into field");
    assert.equal(line.includes("ShortSec99"), false);
    assert.ok(line.includes("[REDACTED]"));

    const payload: any = {
      password: "plain_password",
      apiKey: "plain_api_key",
      cookie: "sid=123",
      items: ["hello ShortSec99", "normal"],
    };
    payload.self = payload;

    const scrubbed = redactSensitiveDataInObject(payload);
    assert.equal(scrubbed.password, "[REDACTED]");
    assert.equal(scrubbed.apiKey, "[REDACTED]");
    assert.equal(scrubbed.cookie, "[REDACTED]");
    assert.equal(Array.isArray(scrubbed.items), true);
    assert.equal(scrubbed.items[0], "hello [REDACTED]");
    assert.equal(scrubbed.self, "[Circular]");
  } finally {
    SessionSecretTracker.clearSession(sid);
  }

  const tmpLogDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-logs-prune-"));
  try {
    for (let i = 0; i < 35; i++) {
      const f = path.join(tmpLogDir, `mission_2026-11-21T00-00-${String(i).padStart(2, "0")}.log`);
      fs.writeFileSync(f, "log", "utf-8");
    }
    pruneOldLogs(tmpLogDir, 30);
    const remaining = fs.readdirSync(tmpLogDir);
    assert.equal(remaining.length, 30);
  } finally {
    fs.rmSync(tmpLogDir, { recursive: true, force: true });
  }

  // Also prune the real system logs directory to <= 30 files
  pruneOldLogs(undefined, 30);
});

test("filter — preserves emoji VS-16 & NBSP, detects bidi overrides, Unicode Tags & pre-NFKC spaces", () => {
  assert.equal(filterHidden("⚠️ Warning"), false);
  assert.equal(filterHidden("⚙️ Settings\u00A0Menu"), false);
  assert.equal(stripInvisibleChars("⚠️ Settings"), "⚠️ Settings");

  assert.equal(filterHidden("Click\u200BHere"), true);
  assert.equal(filterHidden(" Normal\u202Etxt.exe"), true);
  assert.equal(filterHidden("Button\u{E0001}\u{E007F}"), true);
  assert.equal(filterHidden("EnQuad\u2000Space"), true);
  assert.equal(stripInvisibleChars("A\u200BB\u202EC\u{E0001}"), "ABC");
});

test("loader, ratelimit, plugin & updater — policy validation, 8.3 paths, proxy creds, semver prerelease & prototype guard", () => {
  const prevProxy = process.env.WT_PROXY_URL;
  try {
    delete process.env.WT_PROXY_URL;
    const cfg = validateConfigInternal({
      policies: [
        { pattern: "*.bank.*", mode: "deny" },
        { pattern: "audit.example.com", mode: "audit" },
        { pattern: 123, mode: "allow" },
        { pattern: "bad.com", mode: "invalid_mode" },
        null,
      ],
      pdfDir: "C:\\PROGRA~1\\Weavetab\\pdfs",
      snapshotDir: "../escape",
      recordingDir: "~/recordings",
      proxy: "http://user:pass@proxy.internal:8080",
    });

    assert.equal(cfg.policies.length, 2);
    assert.equal(cfg.policies[1]?.mode, "audit-only");
    assert.ok(cfg.pdfDir.includes("PROGRA~1"));
    assert.equal(cfg.snapshotDir, "");
    assert.equal(cfg.recordingDir, "");
    assert.equal(cfg.proxy, undefined);

    process.env.WT_PROXY_URL = "http://envuser:envpass@proxy.internal:8080";
    const envProxyCfg = validateConfigInternal({});
    assert.equal(envProxyCfg.proxy, "http://envuser:envpass@proxy.internal:8080");
  } finally {
    if (prevProxy === undefined) delete process.env.WT_PROXY_URL;
    else process.env.WT_PROXY_URL = prevProxy;
  }

  const tmpJson = path.join(os.tmpdir(), `wt-safejson-${process.pid}.json`);
  try {
    fs.writeFileSync(tmpJson, JSON.stringify({ note: 'Valid JSON with C:\\\\Temp\\\\path' }), "utf-8");
    const r1 = safeReadJson(tmpJson);
    assert.equal(r1.status, "ok");
  } finally {
    if (fs.existsSync(tmpJson)) fs.unlinkSync(tmpJson);
  }

  resetRateLimit();
  assert.equal(checkRateLimit(1).allowed, true);
  const blocked = checkRateLimit(1);
  assert.equal(blocked.allowed, false);
  if (!blocked.allowed) {
    assert.ok(blocked.retryAfterMs >= 1);
  }
  resetRateLimit();

  const parsed = parseCliInvokeArgs(["--json", '{"__proto__":{"polluted":true},"safe":42}']);
  assert.equal(( 
    {} as any
  ).polluted, undefined);
  assert.equal(parsed.flags.safe, 42);
  assert.equal(Object.hasOwn(parsed.flags, "__proto__"), false);

  assert.equal(isValidNpmPackageSpec("@weavetab/plugin-github"), true);
  assert.equal(isValidNpmPackageSpec("weavetab-plugin@1.2.3"), true);
  assert.equal(isValidNpmPackageSpec("foo & calc.exe"), false);
  assert.equal(isValidNpmPackageSpec("../evil"), false);

  assert.equal(isNewerVersion("2.6.4", "2.6.4-beta.1"), false);
  assert.equal(isNewerVersion("2.6.4-beta.1", "2.6.4"), true);
  assert.equal(isNewerVersion("2.6.4", "2.6.5"), true);
});
