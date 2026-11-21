import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserPdf } from "../../src/tools/pdf.js";
import { browserSnapshot } from "../../src/tools/snapshot.js";
import { browserInspect } from "../../src/tools/inspect.js";
import { browserFind } from "../../src/tools/find.js";
import { browserPerformance } from "../../src/tools/performance.js";
import { browserEmulate } from "../../src/tools/emulation.js";
import { browserViewport } from "../../src/tools/viewport.js";
import { SessionSecretTracker } from "../../src/security/secrets.js";
import { sessionRegistry } from "../../src/state/session.js";
import { cacheActionMap, clearTabCache } from "../../src/state/cache.js";
import type { Config } from "../../src/config/loader.js";

const cfg = { headless: true, agentId: "default", outputDir: path.join(os.tmpdir(), "wt-batch5-out") } as unknown as Config;

test("pdf — sanitizes '..' filename, auto-appends .pdf, and writes valid buffer", async () => {
  const b64 = Buffer.from("%PDF-1.4\n%test\n").toString("base64");
  const sess: any = {
    Page: { printToPDF: async () => ({ data: b64 }) },
    Runtime: { evaluate: async () => ({ result: {} }) },
  };

  const r1 = await browserPdf(sess, { filename: ".." }, cfg);
  assert.equal(r1.success, true);
  assert.ok(r1.filename.startsWith("capture_") && r1.filename.endsWith(".pdf"));
  assert.ok(fs.existsSync(r1.path));

  const r2 = await browserPdf(sess, { filename: "report" }, cfg);
  assert.equal(r2.filename, "report.pdf");
  assert.ok(fs.existsSync(r2.path));

  try { fs.unlinkSync(r1.path); fs.unlinkSync(r2.path); } catch {}
});

test("snapshot — redacts secrets in MHTML, rejects missing restore file, uses pathToFileURL with spaces", async () => {
  const tid = "snap-sec-tab";
  SessionSecretTracker.registerSecretValue(tid, "snap_secret_555");
  let navUrl = "";
  const sess: any = {
    close: async () => {},
    Page: {
      captureSnapshot: async () => ({ data: "MIME-Version: 1.0\nBody: snap_secret_555" }),
      navigate: async ({ url }: { url: string }) => { navUrl = url; },
    },
    Runtime: { evaluate: async () => ({ result: {} }) },
  };
  sessionRegistry.register(tid, { targetId: tid, session: sess, url: "https://ex.com", title: "Ex", agentId: "default" } as any);
  sessionRegistry.setActive(tid, "default");

  const snapPath = path.join(os.tmpdir(), `wt snap ${Date.now()}.mhtml`);
  try {
    const cap = await browserSnapshot(sess, { action: "capture", filePath: snapPath }, cfg);
    assert.equal(cap.success, true);
    const saved = fs.readFileSync(snapPath, "utf-8");
    assert.ok(!saved.includes("snap_secret_555"), "secret must be redacted in saved MHTML");
    assert.ok(saved.includes("[REDACTED]"));

    await assert.rejects(
      () => browserSnapshot(sess, { action: "restore", filePath: path.join(os.tmpdir(), "nonexistent-9999.mhtml") }, cfg),
      /Snapshot file not found/
    );

    const rest = await browserSnapshot(sess, { action: "restore", filePath: snapPath }, cfg);
    assert.equal(rest.success, true);
    assert.ok(navUrl.startsWith("file:///") && navUrl.includes("%20"), "pathToFileURL must encode spaces cleanly");
  } finally {
    try { fs.unlinkSync(snapPath); } catch {}
    SessionSecretTracker.clearSession(tid);
    sessionRegistry.unregister(tid);
  }
});

test("inspect — drops endsWith ref mismatch (w:1 must not hit w:11) and resolves exact ref in parallel", async () => {
  const tid = "inspect-fix-tab";
  const url = "https://ex.com/ui";
  clearTabCache(tid);
  cacheActionMap(tid, {
    url,
    title: "UI",
    targetId: tid,
    elements: [
      { id: "w:11", role: "button", label: "Wrong", selector: "#wrong", backendNodeId: 11, group: "main_content", fingerprint: "fp", depth: 0, x: 10, y: 10 },
    ],
  });

  const sess: any = {
    close: async () => {},
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url } } }) },
    DOM: {
      enable: async () => {},
      getDocument: async () => ({}),
      describeNode: async ({ backendNodeId }: { backendNodeId: number }) => ({ node: { nodeId: backendNodeId * 10 } }),
      getBoxModel: async () => ({ model: { width: 100, height: 40, content: [0, 0, 100, 0, 100, 40, 0, 40] } }),
      resolveNode: async () => ({ object: { objectId: "obj-11" } }),
      requestNode: async () => null,
    },
    CSS: {
      enable: async () => {},
      getComputedStyleForNode: async () => ({ computedStyle: [{ name: "display", value: "block" }] }),
    },
    DOMDebugger: {
      getEventListeners: async () => ({ listeners: [{ type: "click", useCapture: false, passive: false }] }),
    },
    Runtime: {
      evaluate: async () => ({ result: { value: null } }),
    },
  };
  sessionRegistry.register(tid, { targetId: tid, session: sess, url, title: "UI", agentId: "default" } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    // w:1 must NOT match w:11
    await assert.rejects(
      () => browserInspect(sess, { ref: "w:1" }, cfg),
      /Element not found/
    );

    // Exact w:11 succeeds with boxModel, styles, and listeners
    const res = await browserInspect(sess, { ref: "w:11" }, cfg);
    assert.equal(res.success, true);
    assert.equal(res.data.boxModel.width, 100);
    assert.equal(res.data.computedStyles.display, "block");
    assert.equal(res.data.eventListeners[0].type, "click");
  } finally {
    sessionRegistry.unregister(tid);
    clearTabCache(tid);
  }
});

test("find — guards null document.body, forwards role filter, and redacts secrets in labels", async () => {
  const tid = "find-sec-tab";
  SessionSecretTracker.registerSecretValue(tid, "find_secret_123");
  let lastExpr = "";
  const sess: any = {
    close: async () => {},
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        lastExpr = expression;
        return {
          result: {
            value: JSON.stringify([
              { ref: "w:2", label: "User find_secret_123", tag: "button", x: 1, y: 2, width: 50, height: 20, selector: "#b" },
            ]),
          },
        };
      },
    },
  };
  sessionRegistry.register(tid, { targetId: tid, session: sess, url: "https://ex.com", title: "Ex", agentId: "default" } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    const res = await browserFind(sess, { query: "User", role: "button" }, cfg);
    assert.equal(res.found, true);
    assert.equal(res.label, "User [REDACTED]");
    assert.ok(lastExpr.includes("document.body || document.documentElement"), "must guard null document.body");
    assert.ok(lastExpr.includes("matchesRole"), "must include role filter check");
  } finally {
    SessionSecretTracker.clearSession(tid);
    sessionRegistry.unregister(tid);
  }
});

test("performance — calls Performance.enable, disconnects observers, keeps -1 sentinel, batches 3 sections into 1 eval", async () => {
  let perfEnabled = false;
  const evalExprs: string[] = [];
  const sess: any = {
    Performance: {
      enable: async () => { perfEnabled = true; },
      getMetrics: async () => ({ metrics: [{ name: "Nodes", value: 42 }] }),
    },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        evalExprs.push(expression);
        if (expression.includes("PerformanceObserver")) {
          return { result: { value: JSON.stringify({ fcp: 100, ttfb: 20, domContentLoaded: 200, load: 300, lcp: -1, cls: 0, inp: -1 }) } };
        }
        return {
          result: {
            value: JSON.stringify({
              memory: { usedJSHeapSize: 1000 },
              navigation: { type: "navigate" },
              slowest_resources: [{ name: "app.js", duration: 12 }],
            }),
          },
        };
      },
    },
  };

  const res = await browserPerformance(sess, cfg);
  assert.equal(perfEnabled, true, "Performance.enable() must be called before getMetrics()");
  assert.equal(res.metrics?.Nodes, 42);
  assert.equal(evalExprs.length, 2, "vitals + single batched eval for memory/navigation/resources");
  assert.ok(evalExprs[0].includes("obs.disconnect()"), "vitals script must disconnect PerformanceObservers");
  assert.ok(evalExprs[0].includes("field === 'cls' ? 0 : -1"), "must preserve -1 sentinel for lcp/inp");
  assert.equal(res.memory?.usedJSHeapSize, 1000);
  assert.equal(res.slowest_resources?.[0]?.name, "app.js");
});

test("emulation — rejects unknown network preset & invalid cpu rate, resets colorScheme with empty string", async () => {
  let mediaFeatures: any[] = [];
  const sess: any = {
    Network: { enable: async () => {}, emulateNetworkConditions: async () => {} },
    Emulation: {
      setCPUThrottlingRate: async () => {},
      setEmulatedMedia: async ({ features }: { features: any[] }) => { mediaFeatures = features; },
    },
  };

  const badNet = await browserEmulate(sess, { network: "3g" as any }, cfg);
  assert.equal(badNet.success, false);
  assert.match(badNet.error ?? "", /Unknown network profile/);

  const badCpu = await browserEmulate(sess, { cpuThrottlingRate: 0.5 }, cfg);
  assert.equal(badCpu.success, false);
  assert.match(badCpu.error ?? "", />= 1/);

  const clearScheme = await browserEmulate(sess, { colorScheme: "no-preference" }, cfg);
  assert.equal(clearScheme.success, true);
  assert.deepEqual(mediaFeatures, [{ name: "prefers-color-scheme", value: "" }]);
});

test("viewport — enables touch emulation on mobile presets and clears touch + media safely in Electron", async () => {
  let touchEnabled: boolean | undefined;
  let clearedMedia: any[] | undefined;
  const sess: any = {
    Emulation: {
      setDeviceMetricsOverride: async () => {},
      clearDeviceMetricsOverride: async () => {},
      setTouchEmulationEnabled: async ({ enabled }: { enabled: boolean }) => { touchEnabled = enabled; },
      setEmulatedMedia: async ({ features }: { features: any[] }) => { clearedMedia = features; },
      clearGeolocationOverride: async () => {},
      setTimezoneOverride: async () => { throw new Error("not supported in Electron"); },
    },
    Network: {
      setUserAgentOverride: async () => {},
    },
  };

  const presetRes = await browserViewport(sess, { action: "preset", devicePreset: "iPhone 15 Pro" }, cfg);
  assert.equal(presetRes.success, true);
  assert.equal(touchEnabled, true, "mobile preset must enable touch emulation via CDP");

  const clearRes = await browserViewport(sess, { action: "clear" }, cfg);
  assert.equal(clearRes.success, true, "clear must succeed even if setTimezoneOverride throws in Electron");
  assert.equal(touchEnabled, false);
  assert.deepEqual(clearedMedia, []);
});
