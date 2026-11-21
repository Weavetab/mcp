import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { browserHighlight } from "../../src/tools/highlight.js";
import { browserThought } from "../../src/tools/thought.js";
import { browserOfficeParse } from "../../src/tools/office/parse.js";
import { browserScroll } from "../../src/tools/scroll.js";
import { SessionSecretTracker } from "../../src/security/secrets.js";
import { sessionRegistry } from "../../src/state/session.js";
import type { Config } from "../../src/config/loader.js";

const cfg = { headless: true, agentId: "default", outputDir: path.join(os.tmpdir(), "wt-batch6-out") } as unknown as Config;

test("highlight — avoids innerHTML XSS on badge label and blocks color JS breakout", async () => {
  const exprs: string[] = [];
  const sess: any = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        exprs.push(expression);
        // Must be valid JS even with hostile quotes/XSS in color & label
        new Function(expression);
        return { result: { value: true } };
      },
    },
  };

  const res = await browserHighlight(
    sess,
    { selector: "#btn", label: `<img src=x onerror="alert(1)">`, color: `red'; alert(1); //` },
    cfg
  );
  assert.equal(res.success, true);
  const overlayExpr = exprs.find(e => e.includes("data-wt-ignore")) ?? "";
  assert.ok(!overlayExpr.includes(".innerHTML"), "highlight must use textContent, never innerHTML");
  assert.ok(overlayExpr.includes("sp.textContent = badgeText"));
  assert.ok(!overlayExpr.includes("alert(1); //"), "unsafe color must be rejected");
});

test("thought — removes stale __wt_ask_bridge on cancelled/timeout and respects >20s timeout", async () => {
  let removedBridge = false;
  let sentTimeout: number | undefined;
  const sess: any = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("WT_THOUGHT")) {
          const m = expression.match(/"timeout":(\d+)/);
          if (m) sentTimeout = Number(m[1]);
        }
        if (expression.includes("el.remove()")) {
          removedBridge = true;
          return { result: {} };
        }
        if (expression.includes("__wt_ask_bridge")) {
          return { result: { value: JSON.stringify({ status: "cancelled", result: "" }) } };
        }
        return { result: {} };
      },
    },
  };

  const res = await browserThought(sess, { action: "question", message: "Proceed?", timeout: 60 });
  assert.equal(res.status, "cancelled");
  assert.equal(removedBridge, true, "must clean up __wt_ask_bridge on cancelled");
  assert.equal(sentTimeout, 60, "must not clamp 60s timeout down to 20s");
});

test("office/parse — uses FileReader + 25MB cap, sniffs word/ ZIP as .docx, redacts CSV secrets", async () => {
  const tid = "office-sec-tab";
  SessionSecretTracker.registerSecretValue(tid, "csv_secret_888");
  let fetchExpr = "";

  // Test 1: CSV fetch redacts tracked secret and uses FileReader + 25MB cap
  const csvB64 = Buffer.from("user,token\nalice,csv_secret_888\n").toString("base64");
  const sess: any = {
    close: async () => {},
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        fetchExpr = expression;
        return { result: { value: JSON.stringify({ base64: csvB64, mimeType: "text/csv" }) } };
      },
    },
  };
  sessionRegistry.register(tid, { targetId: tid, session: sess, url: "https://ex.com", title: "Ex", agentId: "default" } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    const csvRes = await browserOfficeParse(sess, { url: "https://ex.com/export.csv" }, cfg);
    assert.equal(csvRes.success, true);
    assert.equal(csvRes.data[0].token, "[REDACTED]");
    assert.ok(fetchExpr.includes("FileReader"), "must use native FileReader instead of O(N^2) byte concat");
    assert.ok(fetchExpr.includes("26214400"), "must enforce 25MB fetch size cap");

    // Test 2: ZIP magic bytes containing "word/" under application/octet-stream sniffs as .docx (not .xlsx)
    const fakeDocxZip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("word/document.xml")]);
    sess.Runtime.evaluate = async () => ({
      result: { value: JSON.stringify({ base64: fakeDocxZip.toString("base64"), mimeType: "application/octet-stream" }) },
    });
    const docxRes = await browserOfficeParse(sess, { url: "https://s3.test/signed-download" }, cfg);
    assert.equal(docxRes.type, ".docx", "ZIP with word/ entry must sniff as .docx even with octet-stream MIME");
  } finally {
    SessionSecretTracker.clearSession(tid);
    sessionRegistry.unregister(tid);
  }
});

test("scroll — survives missing extension HUD and scrolls off-screen target element into view", async () => {
  let evalExpr = "";
  let wheelDispatched = false;
  const sess: any = {
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url: "file:///C:/app/index.html" } } }) },
    Input: {
      dispatchMouseEvent: async (ev: any) => {
        if (ev.type === "mouseWheel") wheelDispatched = true;
      },
    },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("Weavetab_STATE")) throw new Error("no extension in Electron");
        if (expression.includes("getBoundingClientRect")) {
          evalExpr = expression;
          return { result: { value: { x: 200, y: 200 } } };
        }
        return { result: { value: JSON.stringify({ x: 400, y: 300 }) } };
      },
    },
  };

  const res = await browserScroll(sess, { id: "#panel", direction: "down", distance: 200 }, cfg);
  assert.equal(res.success, true);
  assert.equal(wheelDispatched, true);
  assert.ok(evalExpr.includes("el.scrollIntoView"), "must scroll off-screen element into view before mouseWheel");
});
