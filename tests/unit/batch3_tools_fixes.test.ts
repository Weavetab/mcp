import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import clipboardy from "clipboardy";
import { browserStorage } from "../../src/tools/storage.js";
import { browserCookies } from "../../src/tools/cookies.js";
import { weaveTypeSecret } from "../../src/tools/type_secret.js";
import { browserClipboard } from "../../src/tools/clipboard.js";
import { browserAutomation } from "../../src/tools/automation.js";
import { browserBurst } from "../../src/tools/burst.js";
import { browserConsole, initConsoleBuffering, cleanupConsoleBuffer } from "../../src/tools/console.js";
import { SessionSecretTracker, secretStore } from "../../src/security/secrets.js";
import { sessionRegistry } from "../../src/state/session.js";
import { cacheActionMap, clearTabCache } from "../../src/state/cache.js";
import type { Config } from "../../src/config/loader.js";

const cfg = { headless: true, agentId: "default", navigationTimeout: 1000, policies: [], block: [], allow: [] } as unknown as Config;

test("storage — blocks scope JS injection, redacts secrets, and caps list values", async () => {
  const tid = "storage-sec-tab";
  SessionSecretTracker.registerSecretValue(tid, "tok_secret_9876");
  const sess: any = {
    close: async () => {},
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (!expression.includes("s.length") && expression.includes("getItem")) {
          return { result: { value: "Bearer tok_secret_9876" } };
        }
        return {
          result: {
            value: [
              { key: "auth", value: "tok_secret_9876" },
              { key: "huge", value: "x".repeat(3000) },
            ],
          },
        };
      },
    },
  };
  sessionRegistry.register(tid, { targetId: tid, session: sess, url: "https://ex.com", title: "Ex", agentId: "default" } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    await assert.rejects(
      () => browserStorage(sess, { scope: "alert(1);//" as any, action: "list" }, cfg),
      /invalid scope/i
    );

    const got = await browserStorage(sess, { scope: "local", action: "get", key: "auth" }, cfg);
    assert.equal(got.result, "Bearer [REDACTED]");

    const listed = await browserStorage(sess, { scope: "local", action: "list" }, cfg);
    assert.equal(listed.data?.[0]?.value, "[REDACTED]");
    assert.ok((listed.data?.[1]?.value?.length ?? 0) < 2050, "list must truncate huge values");
    assert.match(listed.data?.[1]?.value ?? "", /\+1000 chars/);
  } finally {
    SessionSecretTracker.clearSession(tid);
    sessionRegistry.unregister(tid);
  }
});

test("cookies — redacts secrets, does not mutate caller args, and preserves real delete errors", async () => {
  const tid = "cookies-sec-tab";
  SessionSecretTracker.registerSecretValue(tid, "cookie_secret_xyz");
  const sess: any = {
    close: async () => {},
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url: "https://secure.example.com" } } }) },
    Network: {
      getCookies: async () => ({
        cookies: [{ name: "sid", value: "v=cookie_secret_xyz", domain: "secure.example.com", path: "/", expires: 0, httpOnly: true, secure: true }],
      }),
      setCookie: async () => {},
      deleteCookies: async () => { throw new Error("CDP_NET_DOWN"); },
    },
  };
  sessionRegistry.register(tid, { targetId: tid, session: sess, url: "https://secure.example.com", title: "Sec", agentId: "default" } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    const got = await browserCookies(sess, { action: "get" }, cfg);
    assert.equal(got.action, "get");
    if (got.action === "get") {
      assert.equal(got.cookies[0]?.value, "v=[REDACTED]");
    }

    const setArgs: any = { action: "set", name: "k", value: "v" };
    await browserCookies(sess, setArgs, cfg);
    assert.equal(setArgs.secure, undefined, "must not mutate caller args.secure");

    await assert.rejects(
      () => browserCookies(sess, { action: "delete", name: "sid" }, cfg),
      /CDP_NET_DOWN/
    );
  } finally {
    SessionSecretTracker.clearSession(tid);
    sessionRegistry.unregister(tid);
  }
});

test("type_secret — blocks file:// empty host, prevents w:1->w:11 mis-target, fixes focused selector", async () => {
  const tid = "type-secret-tab";
  const origGetDomains = secretStore.getDomains.bind(secretStore);
  const origCheckDomain = secretStore.checkDomain.bind(secretStore);
  const origGetSecret = secretStore.getSecret.bind(secretStore);

  (secretStore as any).getDomains = () => ["app.example.com"];
  (secretStore as any).checkDomain = (_k: string, h: string) => h === "app.example.com";
  (secretStore as any).getSecret = async () => "MySecretPass_99";

  try {
    // 1. file:// empty hostname must hard-fail INVALID_URL
    const fileSess: any = {
      Page: { getFrameTree: async () => ({ frameTree: { frame: { url: "file:///C:/app/login.html" } } }) },
    };
    const fileRes = await weaveTypeSecret(fileSess, { id: "w:1", envKey: "PW" }, cfg);
    assert.equal(fileRes.success, false);
    assert.equal(fileRes.error_code, "INVALID_URL");

    // 2. w:1 must NOT match w:11 via endsWith
    const url = "https://app.example.com/login";
    clearTabCache(tid);
    cacheActionMap(tid, {
      url,
      title: "Login",
      targetId: tid,
      elements: [
        { id: "w:11", role: "textbox", label: "Public search", selector: "#search", group: "main_content", fingerprint: "fp11", depth: 0, x: 10, y: 10 },
      ],
    });
    const evalExprs: string[] = [];
    const sess: any = {
      close: async () => {},
      Page: { getFrameTree: async () => ({ frameTree: { frame: { url } } }) },
      DOM: {
        requestNode: async () => ({ nodeId: 5 }),
        describeNode: async () => ({ node: { backendNodeId: 55 } }),
      },
      Input: { insertText: async () => {} },
      Runtime: {
        evaluate: async ({ expression }: { expression: string }) => {
          evalExprs.push(expression);
          return { result: { objectId: "obj-focused" } };
        },
        callFunctionOn: async () => ({ result: {} }),
      },
    };
    sessionRegistry.register(tid, { targetId: tid, session: sess, url, title: "Login", agentId: "default" } as any);
    sessionRegistry.setActive(tid, "default");

    const misRes = await weaveTypeSecret(sess, { id: "w:1", envKey: "PW" }, cfg);
    assert.equal(misRes.success, false);
    assert.equal(misRes.error_code, "ELEMENT_NOT_FOUND", "w:1 must not match w:11");

    // 3. query === "focused" uses document.activeElement, not querySelector("document.activeElement")
    const focRes = await weaveTypeSecret(sess, { id: "focused", envKey: "PW" }, cfg);
    assert.equal(focRes.success, true);
    assert.ok(
      evalExprs.some(e => e.includes("sel === 'document.activeElement'")),
      "focused query must branch to document.activeElement"
    );
  } finally {
    (secretStore as any).getDomains = origGetDomains;
    (secretStore as any).checkDomain = origCheckDomain;
    (secretStore as any).getSecret = origGetSecret;
    SessionSecretTracker.clearSession(tid);
    sessionRegistry.unregister(tid);
    clearTabCache(tid);
  }
});

test("clipboard — returns success:false on write failure, skips (5,5) click on OS write, redacts read", async () => {
  const tid = "clip-sec-tab";
  SessionSecretTracker.registerSecretValue(tid, "clip_secret_42");
  const origWrite = clipboardy.write;
  const origRead = clipboardy.read;

  let mouseClicks = 0;
  const sess: any = {
    close: async () => {},
    Input: { dispatchMouseEvent: async () => { mouseClicks++; } },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("isSecureContext")) return { result: { value: false } };
        return { result: { value: false } };
      },
    },
  };
  sessionRegistry.register(tid, { targetId: tid, session: sess, url: "http://insecure.test", title: "T", agentId: "default" } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    // OS write succeeds -> must NOT fire a stray (5,5) mouse click
    (clipboardy as any).write = async () => {};
    const okWrite = await browserClipboard(sess, { action: "write", text: "hello" }, cfg);
    assert.equal(okWrite.success, true);
    assert.equal(mouseClicks, 0, "successful OS clipboard write must not click page at (5,5)");

    // Both OS write and browser write fail -> must return success: false (not lie!)
    (clipboardy as any).write = async () => { throw new Error("os clip fail"); };
    const failWrite = await browserClipboard(sess, { action: "write", text: "hello", skipActivation: true }, cfg);
    assert.equal(failWrite.success, false, "failed clipboard write must return success: false");

    // Read redacts tracked session secrets
    (clipboardy as any).read = async () => "copied clip_secret_42 here";
    const readRes = await browserClipboard(sess, { action: "read" }, cfg);
    assert.equal(readRes.success, true);
    assert.equal(readRes.text, "copied [REDACTED] here");
  } finally {
    (clipboardy as any).write = origWrite;
    (clipboardy as any).read = origRead;
    SessionSecretTracker.clearSession(tid);
    sessionRegistry.unregister(tid);
  }
});

test("automation — stop unregisters persistent new-document script, caps mailbox, redacts poll", async () => {
  const tid = "auto-sec-tab";
  SessionSecretTracker.registerSecretValue(tid, "auto_tok_999");
  let removedId = "";
  let addedSource = "";

  const sess: any = {
    close: async () => {},
    Page: {
      addScriptToEvaluateOnNewDocument: async ({ source }: { source: string }) => {
        addedSource = source;
        return { identifier: "doc-script-7" };
      },
      removeScriptToEvaluateOnNewDocument: async ({ identifier }: { identifier: string }) => {
        removedId = identifier;
      },
    },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("mb.splice")) {
          return { result: { value: JSON.stringify([{ data: { leak: "auto_tok_999" }, timestamp: "t1" }]) } };
        }
        return { result: { value: true } };
      },
    },
  };
  sessionRegistry.register(tid, { targetId: tid, session: sess, url: "https://ex.com", title: "Ex", agentId: "default" } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    const started = await browserAutomation(sess, { action: "start", id: "job1", script: "1+1", persistent: true }, cfg);
    assert.equal(started.success, true);
    assert.ok(addedSource.includes("_resultMailbox.length > 100"), "mailbox must be capped at 100");

    const polled = await browserAutomation(sess, { action: "poll" }, cfg);
    assert.equal(polled.success, true);
    assert.equal(polled.results?.[0]?.data?.leak, "[REDACTED]");

    const stopped = await browserAutomation(sess, { action: "stop", id: "job1" }, cfg);
    assert.equal(stopped.success, true);
    assert.equal(removedId, "doc-script-7", "stop must remove persisted new-document script");
  } finally {
    SessionSecretTracker.clearSession(tid);
    sessionRegistry.unregister(tid);
  }
});

test("burst — fill_form builds valid browser_fill({ fields }) and click_and_wait passes { for }", async () => {
  const evals: string[] = [];
  const sess: any = {
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url: "https://ex.com" } } }) },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        evals.push(expression);
        if (expression.includes("document.querySelectorAll('input:not")) {
          throw new Error("fill_form triggered scan mode instead of filling fields!");
        }
        if (expression.includes("MutationObserver")) {
          return { result: { value: { found: true } } };
        }
        return { result: { value: JSON.stringify({ exists: false, type: "unknown", fillable: false, isSecret: false }) } };
      },
    },
    Input: { dispatchMouseEvent: async () => {}, dispatchKeyEvent: async () => {} },
  };

  // fill_form should emit 1 browser_fill step with { fields: [...] }, NOT trigger scan mode
  const res = await browserBurst(
    sess,
    {
      steps: [{ tool: "fill_form", args: { fields: { "#user": "alice", "#bio": "dev" } } }],
      stop_on_error: false,
    },
    cfg
  );
  assert.equal(res.steps_completed, 1, "fill_form should collapse into a single browser_fill step");
  assert.equal(res.results[0]?.tool, "browser_fill");

  // click_and_wait with wait_for should pass { for: "text" } to browser_wait
  const waitRes = await browserBurst(
    sess,
    {
      steps: [{ tool: "click_and_wait", args: { x: 10, y: 10, wait_for: "text", wait_value: "Done" } }],
      stop_on_error: false,
    },
    cfg
  );
  const waitStep = waitRes.results.find(r => r.tool === "browser_wait");
  assert.ok(waitStep, "expected expanded browser_wait step");
  assert.equal(waitStep.success, true, "click_and_wait must pass `for` (not `wait_for`) to browser_wait");
});

test("console — preserves 0/false args, filters noise on ext path, redacts & truncates long entries", async () => {
  const tid = "console-fix-tab";
  cleanupConsoleBuffer(tid);
  SessionSecretTracker.registerSecretValue(tid, "console_sec_77");

  const rtEE = new EventEmitter();
  const pageEE = new EventEmitter();
  const sess: any = {
    Runtime: Object.assign(rtEE, {
      evaluate: async () => ({ result: { value: null } }),
    }),
    Page: pageEE,
  };

  initConsoleBuffering(sess, tid);
  rtEE.emit("consoleAPICalled", {
    type: "log",
    timestamp: 1,
    args: [{ value: 0 }, { value: false }, { value: "console_sec_77" }],
  });
  rtEE.emit("consoleAPICalled", {
    type: "log",
    timestamp: 2,
    args: [{ value: "A".repeat(1500) }],
  });

  const cdpRead = await browserConsole(sess, { action: "read" }, cfg, tid);
  assert.equal(cdpRead.logs[0]?.text, "0 false [REDACTED]");
  assert.ok(cdpRead.logs[1]?.text.endsWith("... (truncated)"));
  assert.ok((cdpRead.logs[1]?.text.length ?? 0) < 1050);

  // Extension path must also strip internal Weavetab noise
  sess.Runtime.evaluate = async () => ({
    result: {
      value: [
        { level: "log", text: "[Weavetab] Cursor host missing", time: 3 },
        { level: "warn", text: "real app warning", time: 4 },
      ],
    },
  });
  const extRead = await browserConsole(sess, { action: "read" }, cfg, tid);
  assert.equal(extRead.logs.length, 1);
  assert.equal(extRead.logs[0]?.text, "real app warning");

  SessionSecretTracker.clearSession(tid);
  cleanupConsoleBuffer(tid);
});
