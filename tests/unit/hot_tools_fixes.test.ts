import test from "node:test";
import assert from "node:assert/strict";
import { browserEval } from "../../src/tools/eval.js";
import { browserCanvas } from "../../src/tools/canvas.js";
import { browserScreenshot } from "../../src/tools/screenshot.js";
import { browserMap } from "../../src/tools/read.js";
import { weaveClick } from "../../src/tools/click.js";
import { SessionSecretTracker } from "../../src/security/secrets.js";
import { cacheActionMap, clearTabCache } from "../../src/state/cache.js";
import { sessionRegistry } from "../../src/state/session.js";
import type { Config } from "../../src/config/loader.js";

const cfg = { headless: true, agentId: "default" } as Config;

test("eval — bare arrow/function expressions are invoked and title is fetched once", async () => {
  const seenExprs: string[] = [];
  const sess: any = {
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url: "https://example.com" } } }) },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        seenExprs.push(expression);
        if (expression.includes("location.href")) {
          return { result: { type: "object", value: { url: "https://example.com", title: "" } } };
        }
        if (expression === "(() => 42)()") {
          return { result: { type: "number", value: 42 } };
        }
        if (expression === "(function() { return 'ok'; })()") {
          return { result: { type: "string", value: "ok" } };
        }
        return { result: { type: "undefined" } };
      },
    },
  };

  const r1 = await browserEval(sess, { expression: "() => 42" }, cfg);
  assert.equal(r1.success, true);
  assert.equal(r1.result, 42);
  assert.equal(r1.title, "");
  assert.equal(seenExprs.filter(e => e.includes("document.title")).length, 1);

  const r2 = await browserEval(sess, { expression: "function() { return 'ok'; }" }, cfg);
  assert.equal(r2.success, true);
  assert.equal(r2.result, "ok");
});

test("eval — recursively redacts secrets inside returned objects and arrays", async () => {
  const tid = "eval-secret-tab";
  SessionSecretTracker.registerSecretValue(tid, "sk-live-supersecret99");
  const prev = sessionRegistry.getActive("default");
  const sess: any = {
    close: async () => {},
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("location.href")) {
          return { result: { type: "object", value: { url: "https://app.test", title: "App" } } };
        }
        return {
          result: {
            type: "object",
            value: {
              token: "Bearer sk-live-supersecret99",
              nested: [{ key: "sk-live-supersecret99" }, 123],
            },
          },
        };
      },
    },
  };
  sessionRegistry.register(tid, { targetId: tid, session: sess, url: "https://app.test", title: "App", agentId: "default" } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    const res = await browserEval(sess, { expression: "window.__state" }, cfg);
    assert.equal(res.success, true);
    assert.equal(res.result.token, "Bearer [REDACTED]");
    assert.equal(res.result.nested[0].key, "[REDACTED]");
    assert.equal(res.result.nested[1], 123);
  } finally {
    SessionSecretTracker.clearSession(tid);
    sessionRegistry.unregister(tid);
    if (prev) sessionRegistry.setActive(prev.targetId, "default");
  }
});

test("canvas — resolveCanvasViaCDP uses valid functionDeclaration and draw sets buttons:1", async () => {
  let fnDecl = "";
  const mouseEvents: any[] = [];
  const dataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  const sess: any = {
    DOM: {
      pushNodesByBackendIdsToFrontend: async () => ({ nodeIds: [77] }),
      resolveNode: async () => ({ object: { objectId: "obj-1" } }),
    },
    Runtime: {
      callFunctionOn: async ({ functionDeclaration }: { functionDeclaration: string }) => {
        fnDecl = functionDeclaration;
        // Validate JS syntax of functionDeclaration as a function expression
        new Function(`return (${functionDeclaration})`);
        return { result: { value: JSON.stringify({ x: 10, y: 20, dataUrl }) } };
      },
      evaluate: async () => ({ result: { value: null } }),
    },
    Input: {
      dispatchMouseEvent: async (ev: any) => {
        mouseEvents.push(ev);
      },
    },
  };

  const img = await browserCanvas(sess, { action: "get_image", backendNodeId: 99 }, cfg);
  assert.equal(img.success, true);
  assert.equal(img.dataUrl, dataUrl);
  assert.ok(!fnDecl.trim().endsWith("()"), "functionDeclaration must not have trailing ()");

  const draw = await browserCanvas(
    sess,
    { action: "draw", backendNodeId: 99, points: [{ x: 0, y: 0 }, { x: 15, y: 25 }] },
    cfg
  );
  assert.equal(draw.success, true);
  const dragMove = mouseEvents.find(e => e.type === "mouseMoved" && e.button === "left");
  assert.ok(dragMove, "expected drag mouseMoved event");
  assert.equal(dragMove.buttons, 1);
});

test("screenshot — reports scaled dimensions for >1280px viewports and survives missing viewport eval", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  const wideSess: any = {
    Runtime: {
      evaluate: async () => ({ result: { value: JSON.stringify({ w: 1920, h: 1080, dpr: 1 }) } }),
    },
    Page: {
      captureScreenshot: async () => ({ data: png }),
    },
  };
  const scaled = await browserScreenshot(wideSess, {}, cfg);
  assert.equal(scaled.width, 1280);
  assert.equal(scaled.height, 720);
  assert.equal(scaled.format, "jpeg");

  const brokenVpSess: any = {
    Runtime: {
      evaluate: async () => ({ result: {} }),
    },
    Page: {
      captureScreenshot: async () => ({ data: png }),
    },
  };
  const fallback = await browserScreenshot(brokenVpSess, {}, cfg);
  assert.equal(fallback.success, true);
  assert.equal(fallback.width, 1280);
  assert.equal(fallback.height, 720);
});

test("browser_map — cache hit skips stability wait completely", async () => {
  const tid = "map-cache-hit-tab";
  const url = "file:///C:/app/electron.html";
  clearTabCache(tid);
  cacheActionMap(tid, {
    url,
    title: "Electron App",
    targetId: tid,
    elements: [
      { id: "w:1", role: "button", label: "Save", group: "main_content", fingerprint: "fp1", depth: 0, x: 50, y: 50 },
    ],
  });

  let stabilityWaitCalled = false;
  const sess: any = {
    close: async () => {},
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url } } }) },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("readyState")) stabilityWaitCalled = true;
        if (expression.includes("innerHTML.length")) return { result: { value: 100 } };
        return { result: { value: null } };
      },
    },
  };

  const t0 = Date.now();
  const out = await browserMap(sess, { delta: false }, tid, cfg);
  const elapsed = Date.now() - t0;

  assert.equal(typeof out, "string");
  assert.equal(stabilityWaitCalled, false, "cache hit must not run stability wait");
  assert.ok(elapsed < 250, `expected fast cache hit, took ${elapsed}ms`);
  clearTabCache(tid);
});

test("browser_map — AX tree path uses DOM.getDocument depth:0 and maps backendNodeIds by Map without dropping", async () => {
  const tid = "map-backend-id-tab";
  const url = "https://app.example/mixed";
  clearTabCache(tid);

  let requestedDepth: number | undefined;
  const sess: any = {
    close: async () => {},
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url } } }) },
    DOM: {
      getDocument: async (opts: any) => {
        requestedDepth = opts?.depth;
        return { root: { nodeId: 1 } };
      },
      pushNodesByBackendIdsToFrontend: async ({ backendNodeIds }: { backendNodeIds: number[] }) => ({
        nodeIds: backendNodeIds.map(id => (id === 200 ? 0 : id + 1000)),
      }),
    },
    Accessibility: {
      getFullAXTree: async () => ({
        nodes: [
          { nodeId: "1", role: { value: "button" }, name: { value: "NoBackend" } },
          { nodeId: "2", backendDOMNodeId: 100, role: { value: "button" }, name: { value: "KeepMe" } },
          { nodeId: "3", backendDOMNodeId: 200, role: { value: "button" }, name: { value: "DropDead" } },
          { nodeId: "4", backendDOMNodeId: 300, role: { value: "button" }, name: { value: "KeepTail" } },
        ],
      }),
    },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("readyState")) return { result: { value: true } };
        if (expression.includes("document.title")) return { result: { value: "Mixed" } };
        if (expression.includes("innerHTML.length")) return { result: { value: 50 } };
        return { result: { value: null } };
      },
    },
  };

  const out = await browserMap(sess, { ax_tree: true, delta: false }, tid, cfg);
  assert.equal(typeof out, "string");
  assert.equal(requestedDepth, 0, "DOM.getDocument must use depth: 0");
  assert.ok((out as string).includes("KeepMe"));
  assert.ok((out as string).includes("KeepTail"), "tail element must not be dropped by index mismatch");
  assert.ok(!(out as string).includes("DropDead"), "unresolvable nodeId 0 must be filtered out");
  clearTabCache(tid);
});

test("click — Electron file:// URL succeeds without throwing and skips dead post-click evals", async () => {
  const tid = "electron-click-tab";
  const url = "file:///C:/Users/dev/electron-app/index.html";
  clearTabCache(tid);
  cacheActionMap(tid, {
    url,
    title: "Electron",
    targetId: tid,
    elements: [
      { id: "w:1", role: "button", label: "Run", group: "main_content", fingerprint: "fp1", depth: 0, x: 40, y: 40 },
    ],
  });

  const evals: string[] = [];
  const sess: any = {
    close: async () => {},
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url } } }) },
    DOM: {},
    Input: { dispatchMouseEvent: async () => {} },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        evals.push(expression);
        return { result: { value: false } };
      },
    },
  };

  sessionRegistry.register(tid, { targetId: tid, session: sess, url, title: "Electron", agentId: "default", isElectron: true } as any);
  try {
    const res = await weaveClick(sess, { x: 40, y: 40 }, cfg);
    assert.equal(res.success, true);
    assert.equal(evals.some(e => e.includes("window.scrollY")), false, "dead scrollY eval must be gone");
    assert.equal(evals.some(e => e.includes("aria-expanded")), false, "dead aria eval must be gone");
  } finally {
    sessionRegistry.unregister(tid);
    clearTabCache(tid);
  }
});
