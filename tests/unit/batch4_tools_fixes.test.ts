import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { weaveKey } from "../../src/tools/key.js";
import { browserSelect } from "../../src/tools/select.js";
import { browserUpload } from "../../src/tools/upload.js";
import { initDialogHandler, browserDialog, hasOpenDialog } from "../../src/tools/dialog.js";
import { browserRecording } from "../../src/tools/recording.js";
import { browserCheckpoint, clearAllCheckpoints } from "../../src/tools/checkpoint.js";
import { browserPointer } from "../../src/tools/pointer.js";
import { cacheActionMap, clearTabCache } from "../../src/state/cache.js";
import { sessionRegistry } from "../../src/state/session.js";
import type { Config } from "../../src/config/loader.js";

const cfg = { headless: true, agentId: "default", navigationTimeout: 250 } as unknown as Config;

test("key — dispatches parsed effectiveKey, sends text on printable chars, and never clicks arbitrary buttons", async () => {
  const keyEvents: any[] = [];
  const evals: string[] = [];
  const sess: any = {
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url: "https://ex.com" } } }) },
    Input: { dispatchKeyEvent: async (ev: any) => { keyEvents.push(ev); } },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        evals.push(expression);
        return { result: { value: "Title" } };
      },
    },
  };

  await weaveKey(sess, { key: "Ctrl+A" }, cfg);
  assert.equal(keyEvents[0]?.type, "rawKeyDown");
  assert.equal(keyEvents[0]?.key, "A", "rawKeyDown must use parsed effectiveKey, not 'Ctrl+A'");
  assert.equal(keyEvents[0]?.modifiers, 2);

  keyEvents.length = 0;
  await weaveKey(sess, { key: "x" }, cfg);
  assert.equal(keyEvents[0]?.type, "keyDown");
  assert.equal(keyEvents[0]?.text, "x", "printable char must send text");

  keyEvents.length = 0;
  evals.length = 0;
  await weaveKey(sess, { key: "enter" }, cfg);
  assert.equal(keyEvents[0]?.key, "Enter");
  assert.equal(keyEvents[0]?.windowsVirtualKeyCode, 13);
  assert.equal(evals.some(e => e.includes("parent.querySelectorAll('button")), false, "must not blind-click random buttons");
});

test("select — fixes nodeId callFunctionOn syntax, supports mode:'text' and multi-select values", async () => {
  let fnDecl = "";
  let stateReads = 0;
  const sess: any = {
    DOM: {
      pushNodesByBackendIdsToFrontend: async () => ({ nodeIds: [5] }),
      resolveNode: async () => ({ object: { objectId: "sel-obj" } }),
    },
    Runtime: {
      callFunctionOn: async ({ functionDeclaration }: { functionDeclaration: string }) => {
        fnDecl = functionDeclaration;
        new Function(`return (${functionDeclaration})`);
        return { result: { value: "#tags" } };
      },
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("setSelectionRange")) {
          return { result: { value: JSON.stringify({ ok: true, text: "hello world" }) } };
        }
        if (expression.includes("selected:multi:")) {
          return { result: { value: "selected:multi:2" } };
        }
        stateReads++;
        return {
          result: {
            value: JSON.stringify({
              exists: "true",
              isNative: "true",
              selectedIndex: "0",
              value: stateReads <= 2 ? "" : "a,b",
              selectedText: "A",
            }),
          },
        };
      },
    },
  };

  // nodeId + multi-select values
  const multi = await browserSelect(sess, { nodeId: 99, values: ["a", "b"] }, cfg);
  assert.equal(multi.success, true);
  assert.ok(!fnDecl.trim().endsWith("()"), "callFunctionOn functionDeclaration must not end with ()");
  assert.deepEqual(multi.selected, ["a", "b"]);

  // mode: 'text' range selection
  const textSel = await browserSelect(sess, { selector: "#editor", mode: "text", start: 0, end: 11 }, cfg);
  assert.equal(textSel.success, true);
  assert.equal(textSel.selected, "hello world");
});

test("upload — uses cached action map, initializes DOM depth:0, and blocks w:1->w:11 mismatch", async () => {
  const tid = "upload-fix-tab";
  const url = "https://ex.com/up";
  const tmpFile = path.join(os.tmpdir(), `wt-upload-test-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, "ok", "utf-8");

  clearTabCache(tid);
  cacheActionMap(tid, {
    url,
    title: "Upload",
    targetId: tid,
    elements: [
      { id: "w:11", role: "textbox", label: "File", selector: "#f", backendNodeId: 111, group: "form", fingerprint: "fp", depth: 0, x: 10, y: 10 },
    ],
  });

  let docDepth: number | undefined;
  let uploadedFiles: string[] = [];
  const sess: any = {
    close: async () => {},
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url } } }) },
    DOM: {
      getDocument: async (opts: any) => { docDepth = opts?.depth; return { root: { nodeId: 1 } }; },
      pushNodesByBackendIdsToFrontend: async ({ backendNodeIds }: { backendNodeIds: number[] }) => ({ nodeIds: backendNodeIds }),
      setFileInputFiles: async ({ files }: { files: string[] }) => { uploadedFiles = files; },
    },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes(".files?.length")) return { result: { value: true } };
        return { result: { value: null } };
      },
    },
  };
  sessionRegistry.register(tid, { targetId: tid, session: sess, url, title: "Upload", agentId: "default" } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    // w:1 must NOT match w:11 via endsWith
    await assert.rejects(
      () => browserUpload(sess, { ref: "w:1", filePaths: [tmpFile] }, cfg),
      /Upload input not found/
    );

    // Exact w:11 initializes DOM depth:0 and uploads
    const ok = await browserUpload(sess, { ref: "w:11", filePaths: [tmpFile] }, cfg);
    assert.equal(ok.success, true);
    assert.equal(docDepth, 0);
    assert.deepEqual(uploadedFiles, [tmpFile]);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
    sessionRegistry.unregister(tid);
    clearTabCache(tid);
  }
});

test("dialog — escapes toast JS safely, ignores duplicate init, and avoids 100ms delete race", async () => {
  const pageEE = new EventEmitter();
  const evals: string[] = [];
  const sess: any = {
    Page: Object.assign(pageEE, {
      handleJavaScriptDialog: async () => {},
    }),
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        evals.push(expression);
        // Must be syntactically valid JS even with quotes/newlines/backslashes in alert message
        new Function(expression);
        return { result: {} };
      },
    },
  };

  initDialogHandler(sess);
  initDialogHandler(sess); // duplicate init must be ignored
  assert.equal(pageEE.listenerCount("javascriptDialogOpening"), 1);

  pageEE.emit("javascriptDialogOpening", { type: "alert", message: 'evil "quote"\nnewline\\slash' });
  assert.equal(hasOpenDialog(sess), true);
  assert.equal(evals.length, 1);

  await browserDialog(sess, { action: "accept" });
  // Immediately emit a second dialog within the 100ms window — must NOT be wiped by first dialog's cleanup timer
  pageEE.emit("javascriptDialogOpening", { type: "confirm", message: "second dialog" });
  await new Promise(r => setTimeout(r, 130));
  assert.equal(hasOpenDialog(sess), true, "stale 100ms timer from dialog 1 must not delete dialog 2");
  await browserDialog(sess, { action: "dismiss" });
});

test("recording — blocks path traversal sessionId and cleans listener if startScreencast fails", async () => {
  const ee = new EventEmitter();
  const sess: any = Object.assign(ee, {
    Page: {
      startScreencast: async () => { throw new Error("screencast unsupported"); },
      stopScreencast: async () => {},
    },
    Runtime: { evaluate: async () => ({ result: {} }) },
  });

  const bad = await browserRecording(sess, { action: "start", sessionId: "../../etc" }, cfg);
  assert.equal(bad.success, false);
  assert.match(bad.error ?? "", /Invalid recording sessionId/i);

  await assert.rejects(
    () => browserRecording(sess, { action: "start", sessionId: "valid-rec-1" }, cfg),
    /Failed to start screencast/
  );
  assert.equal(ee.listenerCount("Page.screencastFrame"), 0, "failed start must remove Page.screencastFrame listener");
});

test("checkpoint — restore arms loadEventFired before navigate and times out cleanly if load never fires", async () => {
  clearAllCheckpoints();
  const order: string[] = [];
  let url = "https://ex.com/step1";

  const sess: any = {
    Page: {
      getFrameTree: async () => ({ frameTree: { frame: { url } } }),
      loadEventFired: () => {
        order.push("loadEventFired");
        return new Promise(() => {}); // intentionally never resolves to test timeout bound
      },
      navigate: async ({ url: next }: { url: string }) => {
        order.push("navigate");
        url = next;
        return {};
      },
    },
    Network: {
      getCookies: async () => ({ cookies: [] }),
      setCookies: async () => {},
    },
    Runtime: {
      evaluate: async () => ({ result: { value: { localStorage: {}, sessionStorage: {}, scroll: { x: 0, y: 0 }, title: "Step 1" } } }),
    },
  };

  await browserCheckpoint(sess, { action: "save", name: "cp1" }, cfg);
  url = "https://ex.com/step2";

  const t0 = Date.now();
  const restored = await browserCheckpoint(sess, { action: "restore", name: "cp1" }, cfg);
  const elapsed = Date.now() - t0;

  assert.equal(restored.success, true);
  assert.deepEqual(order, ["loadEventFired", "navigate"], "loadEventFired must be armed BEFORE Page.navigate");
  assert.ok(elapsed < 1500, `restore must not hang when loadEventFired never resolves (took ${elapsed}ms)`);
  clearAllCheckpoints();
});

test("pointer — drag_and_drop skips Strategy 3 when Strategy 1 succeeds and resolves end_ref coords", async () => {
  const tid = "pointer-drag-tab";
  const url = "https://ex.com/board";
  clearTabCache(tid);
  cacheActionMap(tid, {
    url,
    title: "Board",
    targetId: tid,
    elements: [
      { id: "w:1", role: "button", label: "Card", selector: "#card", group: "main_content", fingerprint: "fp1", depth: 0, x: 20, y: 20 },
      { id: "w:2", role: "region", label: "Dropzone", selector: "#drop", group: "main_content", fingerprint: "fp2", depth: 0, x: 220, y: 220 },
    ],
  });

  const mouseEvents: any[] = [];
  const dragEvents: any[] = [];
  const sess: any = {
    close: async () => {},
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url } } }) },
    Input: {
      dispatchMouseEvent: async (ev: any) => { mouseEvents.push(ev); },
      dispatchDragEvent: async (ev: any) => { dragEvents.push(ev); },
    },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("#drop") && expression.includes("getBoundingClientRect")) {
          return { result: { value: { x: 220, y: 220 } } };
        }
        if (expression.includes("#card") && expression.includes("getBoundingClientRect")) {
          return { result: { value: { x: 20, y: 20, w: 80, h: 40, tag: "DIV" } } };
        }
        return { result: { value: null } };
      },
    },
  };
  sessionRegistry.register(tid, { targetId: tid, session: sess, url, title: "Board", agentId: "default" } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    const res = await browserPointer(sess, { action: "drag_and_drop", ref: "w:1", end_ref: "w:2" }, cfg);
    assert.equal(res.success, true);
    assert.equal(res.end_x, 220, "end_ref must populate returned end_x");
    assert.equal(res.end_y, 220, "end_ref must populate returned end_y");
    assert.ok(dragEvents.some(e => e.type === "drop"), "Strategy 1 CDP drag should have run");
    assert.equal(
      mouseEvents.some(e => e.type === "mousePressed"),
      false,
      "Strategy 3 mouse drag must NOT run again after Strategy 1 succeeded"
    );
  } finally {
    sessionRegistry.unregister(tid);
    clearTabCache(tid);
  }
});
