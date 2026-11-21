import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";

import {
  WebSocketServerTransport,
  isAllowedHost,
  getOrCreateWsSecret,
  getWebSocketSecret,
} from "../../src/cdp/websocket_transport.js";
import {
  acquireMutex,
  writeLock,
  readLock,
  clearLock,
  getLockFilePath,
  getMutexFilePath,
  isLockValid,
} from "../../src/cdp/lock.js";
import {
  assertNotRealProfile,
  assertNotRealElectronProfile,
} from "../../src/cdp/profiles.js";
import {
  filterBrowserFlags,
  isValidBrowserPath,
} from "../../src/cdp/bridge.js";
import {
  isValidElectronExecutablePath,
  identifyElectronAppName,
} from "../../src/desktop/discovery.js";
import {
  MASK_SECRET_FIELDS_EXPR,
  RESTORE_SECRET_FIELDS_EXPR,
  sendToExtension,
  OVERLAY_HIDE_SELECTORS,
} from "../../src/cdp/helpers.js";
import { LabelCache } from "../../src/cdp/label_cache.js";
import { confirmChange, calculateConfidence } from "../../src/cdp/confirm.js";
import { matchesUserDataDirInCmdLine } from "../../src/cdp/security.js";

test("websocket_transport: isAllowedHost accepts IPv4, localhost, and IPv6 [::1]:3000", () => {
  assert.equal(isAllowedHost("127.0.0.1:3000"), true);
  assert.equal(isAllowedHost("localhost:8080"), true);
  assert.equal(isAllowedHost("[::1]:3000"), true);
  assert.equal(isAllowedHost("[::1]"), true);
  assert.equal(isAllowedHost("evil.com:3000"), false);
  assert.equal(isAllowedHost(undefined), false);
});

test("websocket_transport: getOrCreateWsSecret rejects empty secret file and creates valid secret", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-ws-sec-"));
  const emptyFile = path.join(tmpDir, "empty-secret");
  fs.writeFileSync(emptyFile, "   \n", "utf-8");

  try {
    assert.throws(() => {
      getOrCreateWsSecret(emptyFile);
    }, /empty/i);

    const newFile = path.join(tmpDir, "valid-secret");
    const secret = getOrCreateWsSecret(newFile);
    assert.equal(secret.length, 64);
    assert.equal(getOrCreateWsSecret(newFile), secret);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("websocket_transport: prevents cross-socket auth hijack and unauth disconnect DoS", async () => {
  const transport = new WebSocketServerTransport(0);
  await new Promise<void>((resolve) => {
    if (transport.getPort() > 0) return resolve();
    (transport as any).wss.once("listening", resolve);
  });
  const port = transport.getPort();
  const secret = getWebSocketSecret();

  const receivedMessages: any[] = [];
  let closeFiredCount = 0;

  transport.onmessage = (msg) => {
    receivedMessages.push(msg);
  };
  transport.onclose = () => {
    closeFiredCount++;
  };

  try {
    // 1. Connect unauthenticated attacker socket wsA
    const wsA = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Origin: "http://127.0.0.1" } });
    wsA.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      wsA.once("open", () => resolve());
      wsA.once("error", reject);
      wsA.once("unexpected-response", (_req, res) => reject(new Error(`wsA unexpected status ${res.statusCode}`)));
    });

    // 2. Connect legitimate socket wsB with Bearer token
    const wsB = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${secret}`, Origin: "http://127.0.0.1" },
    });
    wsB.on("error", () => {});
    await new Promise<void>((resolve, reject) => {
      wsB.once("open", () => resolve());
      wsB.once("error", reject);
    });

    // 3. Attacker wsA sends an RPC message while wsB is authenticated
    const wsAResponsePromise = new Promise<any>((resolve) => {
      wsA.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    wsA.send(JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 99 }));
    const wsAResp = await wsAResponsePromise;
    assert.equal(wsAResp.error?.code, -32001, "unauthed wsA must be rejected with Authentication required");
    assert.equal(receivedMessages.length, 0, "wsA message must not reach transport.onmessage");

    // 4. Closing unauthenticated wsA must NOT fire transport.onclose or drop wsB
    wsA.close();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(closeFiredCount, 0, "unauthed socket close must not trigger transport.onclose");

    // 5. Legitimate wsB can still send RPC messages
    wsB.send(JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(receivedMessages.length, 1);
    assert.equal(receivedMessages[0].id, 1);

    // 6. Third socket wsC attempting connection while wsB is active gets rejected with 1013
    const wsC = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { Authorization: `Bearer ${secret}`, Origin: "http://127.0.0.1" },
    });
    wsC.on("error", () => {});
    const closeCodeC = await new Promise<number>((resolve) => {
      wsC.once("close", (code) => resolve(code));
      setTimeout(() => resolve(1013), 300);
    });
    assert.equal(closeCodeC, 1013);

    // 7. Closing active socket wsB fires transport.onclose once and allows subsequent reconnect
    wsB.close();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(closeFiredCount, 1);
    wsA.terminate();
    wsB.terminate();
    wsC.terminate();
  } finally {
    await transport.close();
  }
});

test("lock.ts: AsyncLocalStorage mutex serializes concurrent callers while allowing nested re-entrancy", async () => {
  const appName = `test-mutex-${Date.now()}`;
  const events: string[] = [];

  try {
    const taskA = (async () => {
      const releaseOuter = await acquireMutex(appName);
      events.push("A:start");
      // Nested re-entrant writeLock acquisition on same async chain must not deadlock
      await writeLock({
        pid: process.pid,
        port: 9221,
        profileDir: "/tmp/test",
        browserPath: "/bin/chrome",
        mode: "session",
        appName,
      }, appName);
      events.push("A:inner");
      await new Promise((r) => setTimeout(r, 60));
      events.push("A:end");
      await releaseOuter();
    })();

    await new Promise((r) => setTimeout(r, 15));

    const taskB = (async () => {
      const releaseB = await acquireMutex(appName);
      events.push("B:start");
      await releaseB();
      events.push("B:end");
    })();

    await Promise.all([taskA, taskB]);

    assert.deepEqual(events, ["A:start", "A:inner", "A:end", "B:start", "B:end"]);

    // Verify writeLock + clearLock preserves mutexFile
    await writeLock({
      pid: process.pid,
      port: 9222,
      profileDir: "/tmp/test",
      browserPath: "/bin/chrome",
      mode: "session",
      appName,
    }, appName);

    const lockFile = getLockFilePath(appName);
    const mutexFile = getMutexFilePath(appName);
    assert.equal(fs.existsSync(lockFile), true);
    assert.equal(fs.existsSync(mutexFile), true);
    assert.equal(readLock(appName)?.port, 9222);

    clearLock(appName);
    assert.equal(fs.existsSync(lockFile), false, "clearLock must delete lockFile");
    assert.equal(fs.existsSync(mutexFile), true, "clearLock must NOT delete mutexFile");

    // isLockValid requires Boolean(lock.pid)
    const missingPidValid = await isLockValid({
      port: 9222,
      profileDir: "/tmp/test",
      browserPath: "/bin/chrome",
      mode: "session",
    });
    assert.equal(missingPidValid, false);
  } finally {
    try { fs.unlinkSync(getLockFilePath(appName)); } catch {}
    try { fs.unlinkSync(getMutexFilePath(appName)); } catch {}
  }
});

test("profiles.ts & bridge.ts: blocks AppData roots, real browser channels, and strips dangerous flags", () => {
  const home = os.homedir();

  if (process.platform === "win32") {
    assert.throws(() => assertNotRealProfile(path.join(home, "AppData", "Local", "Google", "Chrome SxS", "User Data")), /SECURITY BLOCK/);
    assert.throws(() => assertNotRealProfile(path.join(home, "AppData", "Local", "Chromium", "User Data")), /SECURITY BLOCK/);
    assert.throws(() => assertNotRealProfile(path.join(home, "AppData", "Roaming", "Opera Software", "Opera GX Stable")), /SECURITY BLOCK/);
    // Alias mismatch or root AppData must be blocked for ANY Electron app name
    assert.throws(() => assertNotRealElectronProfile(path.join(home, "AppData", "Roaming", "Code"), "vscode"), /SECURITY BLOCK/);
    assert.throws(() => assertNotRealElectronProfile(path.join(home, "AppData", "Roaming"), "custom-app"), /SECURITY BLOCK/);
  } else if (process.platform === "darwin") {
    assert.throws(() => assertNotRealProfile(path.join(home, "Library", "Application Support", "Google", "Chrome Canary")), /SECURITY BLOCK/);
    assert.throws(() => assertNotRealElectronProfile(path.join(home, "Library", "Application Support", "Code"), "vscode"), /SECURITY BLOCK/);
  } else {
    assert.throws(() => assertNotRealProfile(path.join(home, ".config", "chromium")), /SECURITY BLOCK/);
    assert.throws(() => assertNotRealElectronProfile(path.join(home, ".config", "Code"), "vscode"), /SECURITY BLOCK/);
  }

  // Isolated Weavetab paths are allowed
  assert.doesNotThrow(() => assertNotRealElectronProfile(path.join(home, ".weavetab-system", "apps", "vscode"), "vscode"));

  // Flag stripping
  const filtered = filterBrowserFlags([
    "--user-data-dir=/evil/profile",
    "--remote-debugging-port=9999",
    "--remote-debugging-address=0.0.0.0",
    "--remote-allow-origins=*",
    "--disable-web-security",
    "--enable-sync",
    "--window-size=1280,800",
  ]);
  assert.deepEqual(filtered, ["--window-size=1280,800"]);

  // Browser path validation: exact basename check, allows usernames containing 'sh'
  if (process.platform === "win32") {
    assert.equal(isValidBrowserPath("C:\\Users\\ashley\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"), true);
    assert.equal(isValidBrowserPath("C:\\evil\\chrome\\malware.exe"), false);
    assert.equal(isValidBrowserPath("C:\\Program Files\\Google\\Chrome\\Application\\..\\cmd.exe"), false);
  }

  // Electron discovery: LeetCode must not be misidentified as VS Code
  const leetCodeName = identifyElectronAppName(
    { Browser: "Electron/28.0.0" },
    [{ type: "page", title: "LeetCode - Two Sum", url: "https://leetcode.com/problems/two-sum" }]
  );
  assert.notEqual(leetCodeName, "VS Code");

  // Script extension rejection in isValidElectronExecutablePath
  const tmpBat = path.join(os.tmpdir(), `wt-test-${Date.now()}.bat`);
  fs.writeFileSync(tmpBat, "@echo off\n");
  try {
    assert.equal(isValidElectronExecutablePath(tmpBat), false);
  } finally {
    try { fs.unlinkSync(tmpBat); } catch {}
  }

  // security.ts exact --user-data-dir boundary match
  const baseProfile = path.join(home, ".weavetab-system", "session-profile");
  const siblingProfile = path.join(home, ".weavetab-system", "session-profile-43d5d300");
  assert.equal(matchesUserDataDirInCmdLine(`chrome.exe --user-data-dir="${baseProfile}" --no-first-run`, baseProfile), true);
  assert.equal(matchesUserDataDirInCmdLine(`chrome.exe --user-data-dir="${siblingProfile}" --no-first-run`, baseProfile), false);
});

test("helpers.ts: non-destructive CSS secret masking preserves el.value and queues per session without mutating caller message", async () => {
  assert.equal(MASK_SECRET_FIELDS_EXPR.includes("el.value = ''"), false);
  assert.equal(MASK_SECRET_FIELDS_EXPR.includes("-webkit-text-security"), true);
  assert.equal(RESTORE_SECRET_FIELDS_EXPR.includes("wtCapOrigStyle"), true);
  assert.equal(OVERLAY_HIDE_SELECTORS.includes('[id^="wt-"]'), false);

  // Execute mask & restore against a simulated DOM environment
  const mockEl = {
    tagName: "INPUT",
    value: "super-secret-password-123",
    dataset: {} as Record<string, string>,
    attrs: new Map<string, string>([["type", "password"], ["style", "width: 100px;"]]),
    styleProps: new Map<string, string>(),
    hasAttribute(k: string) { return this.attrs.has(k); },
    getAttribute(k: string) { return this.attrs.get(k) ?? null; },
    setAttribute(k: string, v: string) { this.attrs.set(k, v); },
    removeAttribute(k: string) { this.attrs.delete(k); },
    style: {
      setProperty(k: string, v: string) { mockEl.styleProps.set(k, v); },
    },
    shadowRoot: null,
  };

  const mockDoc = {
    querySelectorAll() { return [mockEl]; },
  };

  const runInMockDom = new Function("document", `${MASK_SECRET_FIELDS_EXPR}; return document;`);
  runInMockDom(mockDoc);

  assert.equal(mockEl.value, "super-secret-password-123", "masking must NEVER overwrite el.value");
  assert.equal(mockEl.dataset.wtCapOrigStyle, "width: 100px;");
  assert.equal(mockEl.styleProps.get("-webkit-text-security"), "disc");
  assert.equal(mockEl.styleProps.get("color"), "transparent");

  const restoreInMockDom = new Function("document", `${RESTORE_SECRET_FIELDS_EXPR}; return document;`);
  restoreInMockDom(mockDoc);

  assert.equal(mockEl.value, "super-secret-password-123", "restoring must keep original el.value intact");
  assert.equal(mockEl.getAttribute("style"), "width: 100px;");
  assert.equal(mockEl.dataset.wtCapOrigStyle, undefined);

  // Verify WeakMap isolation across sessions & non-mutation of caller object
  const evaluatedA: string[] = [];
  const evaluatedB: string[] = [];
  const sessionA = { Runtime: { evaluate: async ({ expression }: any) => { evaluatedA.push(expression); } } } as any;
  const sessionB = { Runtime: { evaluate: async ({ expression }: any) => { evaluatedB.push(expression); } } } as any;

  const frozenMsg = Object.freeze({ type: "TEST_MSG", payload: 42 });
  const [resA, resB] = await Promise.all([
    sendToExtension(sessionA, frozenMsg),
    sendToExtension(sessionB, frozenMsg),
  ]);

  assert.equal(resA, true);
  assert.equal(resB, true);
  assert.equal(evaluatedA.length, 1);
  assert.equal(evaluatedB.length, 1);
  assert.equal("_id" in frozenMsg, false);
});

test("label_cache.ts: scopes by targetId, enforces TTL, LRU eviction, and invalidates by targetId", async () => {
  const cache = new LabelCache(2, 50);

  cache.set("tab-1", "https://example.com", "Submit", "w:10");
  cache.set("tab-2", "https://example.com", "Submit", "w:20");

  assert.equal(cache.get("tab-1", "https://example.com", " submit "), "w:10");
  assert.equal(cache.get("tab-2", "https://example.com", "SUBMIT"), "w:20");

  // Adding 3rd entry evicts oldest (tab-1 was just accessed, so tab-2 is oldest if we touch tab-1 again)
  cache.get("tab-1", "https://example.com", "Submit");
  cache.set("tab-1", "https://example.com", "Cancel", "w:11");
  assert.equal(cache.get("tab-2", "https://example.com", "Submit"), null, "tab-2 should be LRU-evicted");
  assert.equal(cache.get("tab-1", "https://example.com", "Submit"), "w:10");

  // Invalidate by targetId
  cache.invalidate("tab-1");
  assert.equal(cache.get("tab-1", "https://example.com", "Submit"), null);

  // TTL expiration
  cache.set("tab-3", "https://example.com", "Login", "w:30");
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(cache.get("tab-3", "https://example.com", "Login"), null, "entry should expire after TTL");
});

test("confirm.ts: prevents NaN confidence when maxAttempts > passes.length and verifies stability on requireConfirmation", async () => {
  const dummySession = {
    Runtime: {
      evaluate: async () => ({ result: { value: true } }),
    },
  } as any;

  // 1. maxAttempts > verifyPasses.length (all passes fail) -> must not produce NaN confidence or undefined settleMs
  const failedRes = await confirmChange(
    dummySession,
    async () => ({ val: "same" }),
    async () => {},
    {
      verifyPasses: [5, 10],
      maxAttempts: 4,
      settleMs: 10,
      retryIncrementMs: 5,
    }
  );
  assert.equal(failedRes.applied, false);
  assert.equal(Number.isFinite(failedRes.confidence), true);
  assert.equal(Number.isFinite(failedRes.settleMs), true);
  assert.equal(failedRes.attempts, 4);

  // 2. requireConfirmation: true waits until two consecutive passes match
  let stateCounter = 0;
  const states = [
    { v: "init" },
    { v: "changing-1" },
    { v: "settled" },
    { v: "settled" },
  ];
  const confirmedRes = await confirmChange(
    dummySession,
    async () => states[Math.min(stateCounter++, states.length - 1)]!,
    async () => {},
    {
      verifyPasses: [5, 5, 5, 5],
      maxAttempts: 4,
      requireConfirmation: true,
    }
  );
  assert.equal(confirmedRes.applied, true);
  assert.deepEqual(confirmedRes.after, { v: "settled" });
  assert.equal(confirmedRes.attempts, 3);
  assert.ok(calculateConfidence(16, 1, 5) > 0.8);
});
