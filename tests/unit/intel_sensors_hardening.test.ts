import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { waitForNetworkIdle } from "../../src/sensors/wait.js";
import { TelemetryCapture } from "../../src/sensors/network.js";
import { buildConfigExpr, ensureVisualLayer, getMinimalOverlayScript } from "../../src/overlay/injector.js";
import { DEFAULT_CONFIG, getSystemDir } from "../../src/config/loader.js";
import {
  bumpVisitCount,
  clearMemoryCache,
  detectFramework,
  detectShadowDom,
  getDomainFilePath,
  loadDomainProfile,
} from "../../src/intelligence/sessionMemory.js";
import {
  clearAllSnapshots,
  clearSnapshot,
  computeRichDelta,
  getStoredProps,
  getStoredRef,
  seedRichSnapshot,
} from "../../src/state/delta.js";
import { SessionSecretTracker } from "../../src/security/secrets.js";
import {
  clearToolCallWindow,
  clearTrail,
  detectCrossToolLoop,
  detectStuckLoop,
  getTrail,
  recordAction,
  trackToolCall,
} from "../../src/intelligence/trail.js";
import { analyzeVisualFallback } from "../../src/intelligence/vision.js";

test("waitForNetworkIdle invokes returned unsubscribe functions on idle and deadline", async () => {
  let activeListeners = 0;
  const mockSession: any = {
    Network: {
      enable: async () => {},
      on: (_event: string, _cb: () => void) => {
        activeListeners++;
        let removed = false;
        return () => {
          if (!removed) {
            removed = true;
            activeListeners--;
          }
        };
      },
    },
  };

  await waitForNetworkIdle(mockSession, 20, 200);
  assert.equal(activeListeners, 0, "All 3 Network listeners must be unsubscribed after idle");
});

test("TelemetryCapture lazily attaches on start() and unsubscribes on stop()", async () => {
  let activeListeners = 0;
  const handlers = new Map<string, (p: any) => void>();

  const makeDomain = () => ({
    enable: async () => {},
    on: (ev: string, cb: (p: any) => void) => {
      activeListeners++;
      handlers.set(ev, cb);
      let removed = false;
      return () => {
        if (!removed) {
          removed = true;
          activeListeners--;
          handlers.delete(ev);
        }
      };
    },
  });

  const mockSession: any = {
    Network: makeDomain(),
    Page: makeDomain(),
    DOM: makeDomain(),
    Runtime: makeDomain(),
  };

  const tc = new TelemetryCapture(mockSession);
  assert.equal(activeListeners, 0, "Constructor should not attach listeners eagerly");

  await tc.start();
  assert.equal(activeListeners, 7, "start() should attach 7 CDP domain listeners");

  handlers.get("requestWillBeSent")?.({
    requestId: "r1",
    request: { url: "https://api.example.com/v1/items", method: "GET" },
  });

  const report1 = await tc.stop();
  assert.equal(activeListeners, 0, "stop() must unsubscribe all 7 listeners");
  assert.equal(report1.networkRequests.length, 1);

  await tc.start();
  assert.equal(activeListeners, 7, "Subsequent start() must re-attach listeners cleanly");
  await tc.stop();
  assert.equal(activeListeners, 0);
});

test("injector.ts redacts config to devMode only and removes unauthenticated feedback listener", async () => {
  const sensitiveConfig = {
    ...DEFAULT_CONFIG,
    devMode: true,
    profileDir: "C:\\Secret\\Profile",
    downloadDir: "C:\\Secret\\Downloads",
    proxy: "http://proxy.internal:8080",
    agentId: "secret-agent-uuid",
  };

  const expr = buildConfigExpr(sensitiveConfig);
  assert.ok(expr.includes('"devMode":true'), "Should pass devMode boolean");
  assert.ok(!expr.includes("Secret"), "Must not leak filesystem paths into page expression");
  assert.ok(!expr.includes("proxy.internal"), "Must not leak proxy into page expression");
  assert.ok(!expr.includes("secret-agent-uuid"), "Must not leak agentId into page expression");

  const overlayScript = getMinimalOverlayScript();
  assert.ok(!overlayScript.includes("__WT_FEEDBACK"), "Unauthenticated __WT_FEEDBACK listener must be removed");
  assert.ok(!overlayScript.includes("logDebug("), "Browser script must not call Node logDebug");
  assert.ok(overlayScript.includes("window.__wt_devMode = !!c.devMode"), "devMode must be toggleable off");

  let evalCalls = 0;
  const headlessSession: any = {
    Page: { addScriptToEvaluateOnNewDocument: async () => ({ identifier: "1" }) },
    Runtime: {
      evaluate: async () => {
        evalCalls++;
        return { result: { value: true } };
      },
    },
  };
  await ensureVisualLayer(headlessSession, { ...DEFAULT_CONFIG, headless: true });
  assert.equal(evalCalls, 0, "ensureVisualLayer must short-circuit when headless is true");
});

test("sessionMemory: bumpVisitCount increments visitCount, detectShadowDom loops NodeList, and path traversal is blocked", async () => {
  const testHost = "hardening-visit.weavetab.test";
  clearMemoryCache();
  const filePath = getDomainFilePath(testHost);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  try {
    await bumpVisitCount(testHost);
    await bumpVisitCount(testHost);
    clearMemoryCache();

    const loaded = await loadDomainProfile(testHost);
    assert.ok(loaded !== null, "Profile should be persisted");
    assert.equal(loaded?.visitCount, 2, "visitCount must increment across bumpVisitCount calls");
  } finally {
    clearMemoryCache();
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  const traversalPath = getDomainFilePath("../../etc/passwd");
  const memoryBase = path.resolve(getSystemDir("memory"));
  assert.ok(
    traversalPath.startsWith(memoryBase + path.sep),
    `Path traversal must stay inside ${memoryBase}, got ${traversalPath}`
  );
  assert.ok(!traversalPath.includes(".."), "Sanitized path must not contain '..'");

  let evaluatedExpr = "";
  const shadowSession: any = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        evaluatedExpr = expression;
        return { result: { value: true } };
      },
    },
  };
  const hasShadow = await detectShadowDom(shadowSession);
  assert.equal(hasShadow, true);
  assert.ok(!evaluatedExpr.includes(".some("), "detectShadowDom must not call .some() on NodeList");

  let evalCount = 0;
  const fwSession: any = {
    Runtime: {
      evaluate: async () => {
        evalCount++;
        return { result: { value: "react" } };
      },
    },
  };
  const fw = await detectFramework(fwSession);
  assert.equal(fw, "react");
  assert.equal(evalCount, 1, "detectFramework must run in a single Runtime.evaluate call");
});

test("delta.ts: clearSnapshot clears propSnapshots and secrets are redacted in RefEntry and RichDelta", async () => {
  const targetId = "tab-hardening-delta";
  clearAllSnapshots();
  SessionSecretTracker.clearSession(targetId);
  SessionSecretTracker.registerSecretValue(targetId, "super_secret_pw_123");

  const initial: any[] = [
    {
      id: "w:1",
      role: "textbox",
      label: "Token super_secret_pw_123",
      value: "super_secret_pw_123",
      fingerprint: "textbox:token:form:0",
    },
  ];

  seedRichSnapshot(targetId, "https://example.com/login", initial);

  const storedRef = getStoredRef(targetId, "w:1");
  assert.equal(storedRef?.value, "[REDACTED]", "Stored RefEntry value must be redacted");
  assert.equal(storedRef?.label, "Token [REDACTED]", "Stored RefEntry label must be redacted");

  clearSnapshot(targetId);
  assert.equal(getStoredProps(targetId, "w:1"), undefined, "clearSnapshot must delete propSnapshots entry");

  const afterClear = await computeRichDelta(targetId, "https://example.com/login", initial);
  assert.equal(afterClear, null, "First computeRichDelta after clearSnapshot must re-seed and return null");

  const mutated: any[] = [
    {
      id: "w:1",
      role: "textbox",
      label: "Token super_secret_pw_123",
      value: "prefix_super_secret_pw_123_suffix",
      fingerprint: "textbox:token:form:0",
    },
  ];
  const richDiff = await computeRichDelta(targetId, "https://example.com/login", mutated);
  assert.ok(richDiff !== null && "changed" in richDiff);
  assert.equal(richDiff.changed.length, 1);
  assert.equal(richDiff.changed[0]?.label, "Token [REDACTED]");
  assert.equal(richDiff.changed[0]?.changes.value?.to, "prefix_[REDACTED]_suffix");

  SessionSecretTracker.clearSession(targetId);
  clearAllSnapshots();
});

test("trail.ts: detectStuckLoop checks last 3 consecutive actions and recordAction redacts secrets", () => {
  clearToolCallWindow();
  clearTrail();

  const tabId = "tab-trail-secret";
  SessionSecretTracker.clearSession(tabId);
  SessionSecretTracker.registerSecretValue(tabId, "my_api_key_999");

  recordAction({
    timestamp: new Date().toISOString(),
    tool: "browser_type",
    tabId,
    input: { ref: "w:1", text: "Bearer my_api_key_999" },
    result: { echoed: "my_api_key_999", success: true },
  });

  const last = getTrail()[0]!;
  assert.equal(last.input.text, "Bearer [REDACTED]");
  assert.equal(last.result.echoed, "[REDACTED]");

  trackToolCall("browser_click", "w:1", { success: false });
  trackToolCall("browser_click", "w:1", { success: false });
  assert.equal(detectStuckLoop().stuck, false, "2 calls should not trigger stuck loop");

  trackToolCall("browser_click", "w:1", { success: false });
  assert.equal(detectStuckLoop().stuck, true, "3 identical consecutive calls must trigger stuck loop");

  trackToolCall("browser_click", "w:1", { success: false });
  trackToolCall("browser_click", "w:2", { success: false });
  assert.equal(
    detectStuckLoop().stuck,
    false,
    "[A,A,A,A,B] must not report stuck on B when the latest action changed"
  );

  clearToolCallWindow();
  for (let i = 0; i < 2; i++) {
    trackToolCall("browser_click", "w:1", { success: false });
    trackToolCall("browser_type", "w:1", { success: false });
    trackToolCall("browser_press", "w:1", { success: false });
  }
  const cross = detectCrossToolLoop();
  assert.equal(cross.stuck, true, "MAX_WINDOW_SIZE=6 must allow 3-cycle cross-tool loop detection");

  SessionSecretTracker.clearSession(tabId);
  clearToolCallWindow();
  clearTrail();
});

test("vision.ts: handles 4-channel RGBA PNGs via removeAlpha without stride corruption and preserves blank state", async () => {
  const sharpMod = (await import("sharp")).default;
  const width = 64;
  const height = 64;
  const rgba = Buffer.alloc(width * height * 4, 255);

  const pngBuf = await sharpMod(rgba, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();

  const mockSession: any = {
    Page: {
      captureScreenshot: async () => ({ data: pngBuf.toString("base64") }),
    },
  };

  const res = await analyzeVisualFallback(mockSession);
  assert.equal(res.page_state, "blank", "Solid white RGBA image must be classified as 'blank', not 'error_page'");
  assert.equal(res.text_density, 0);
  assert.equal(res.content_heatmap, "................");
});
