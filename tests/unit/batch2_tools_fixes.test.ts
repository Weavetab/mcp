import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import CDP from "chrome-remote-interface";
import { browserNetworkIntercept, cleanupNetworkIntercept } from "../../src/tools/network_intercept.js";
import { weaveType } from "../../src/tools/type.js";
import { browserFill } from "../../src/tools/fill.js";
import { browserWait } from "../../src/tools/wait.js";
import { browserScrape } from "../../src/tools/scrape.js";
import { weaveNavigate } from "../../src/tools/navigate.js";
import { WeavetabConsolidate, lockTab, unlockTab } from "../../src/tools/tabs.js";
import { cacheActionMap, clearTabCache } from "../../src/state/cache.js";
import { sessionRegistry } from "../../src/state/session.js";
import { getLockFilePath, clearLock } from "../../src/cdp/lock.js";
import type { Config } from "../../src/config/loader.js";

const cfg = { headless: true, agentId: "default", navigationTimeout: 1000, policies: [], block: [], allow: [] } as unknown as Config;

test("network_intercept — escapes glob regex chars, uses continueResponse, and removes listener on cleanup", async () => {
  const ee = new EventEmitter();
  let fulfilled = 0;
  let continuedResp = 0;
  let continuedReq = 0;

  const sess: any = Object.assign(ee, {
    Network: { enable: async () => {}, disable: async () => {} },
    Runtime: { evaluate: async () => ({ result: { value: false } }) },
    Fetch: {
      enable: async () => {},
      disable: async () => {},
      fulfillRequest: async () => { fulfilled++; },
      continueResponse: async () => { continuedResp++; },
      continueRequest: async () => { continuedReq++; },
    },
  });

  // Regex metacharacters (?, (, ), +) would throw or mis-match without escaping
  const res = await browserNetworkIntercept(
    sess,
    { action: "enable", pattern: "*api/v1/users?id=(1)+test*", mockStatus: 201, mockBody: '{"ok":true}' },
    cfg
  );
  assert.equal(res.success, true);
  assert.equal(ee.listenerCount("Fetch.requestPaused"), 1);

  ee.emit("Fetch.requestPaused", { requestId: "r1", request: { url: "https://ex.com/api/v1/users?id=(1)+test" } });
  ee.emit("Fetch.requestPaused", { requestId: "r2", request: { url: "https://ex.com/other" } });
  await new Promise(r => setTimeout(r, 20));

  assert.equal(fulfilled, 1);
  assert.equal(continuedResp, 1, "non-matching Response-stage pause must call continueResponse");
  assert.equal(continuedReq, 0);

  cleanupNetworkIntercept(sess);
  assert.equal(ee.listenerCount("Fetch.requestPaused"), 0, "cleanup must remove Fetch.requestPaused listener");
});

test("type — Electron file:// URL does not throw and exact selector skips fuzzy ambiguity block", async () => {
  const tid = "electron-type-tab";
  const url = "file:///C:/app/form.html";
  clearTabCache(tid);
  cacheActionMap(tid, {
    url,
    title: "Electron Form",
    targetId: tid,
    elements: [
      { id: "w:1", role: "textbox", label: "Work email", selector: "#email", group: "form", fingerprint: "fp1", depth: 0, x: 50, y: 50 },
      { id: "w:2", role: "textbox", label: "Backup email", selector: "#backup-email", group: "form", fingerprint: "fp2", depth: 0, x: 50, y: 90 },
    ],
  });

  const sess: any = {
    close: async () => {},
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url } } }) },
    DOM: {
      pushNodesByBackendIdsToFrontend: async () => ({ nodeIds: [] }),
      resolveNode: async () => ({ object: {} }),
    },
    Input: {
      dispatchMouseEvent: async () => {},
      dispatchKeyEvent: async () => {},
      insertText: async () => {},
    },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("isContentEditable") && expression.includes("spinbutton")) {
          return { result: { value: true } };
        }
        if (expression.includes("getBoundingClientRect") && expression.includes("selector-match")) {
          return { result: { value: { label: "Work email", x: 50, y: 50 } } };
        }
        if (expression.includes("activeElement")) return { result: { value: true } };
        if (expression.includes("reactFiber")) return { result: { value: "vanilla" } };
        return { result: { value: null } };
      },
      callFunctionOn: async () => ({ result: { value: true } }),
    },
  };

  sessionRegistry.register(tid, { targetId: tid, session: sess, url, title: "Electron Form", agentId: "default", isElectron: true } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    const res = await weaveType(sess, { id: "#email", text: "a@b.c", fast: true }, cfg);
    assert.notEqual((res as any).error_code, "AMBIGUOUS_TARGET", "exact selector must not hit fuzzy AMBIGUOUS_TARGET");
    assert.equal(res.success, true);
  } finally {
    sessionRegistry.unregister(tid);
    clearTabCache(tid);
  }
});

test("fill — grid_data supports AA+ columns and fetches AX tree once per batch; ARIA checkbox avoids double-click", async () => {
  let axTreeCalls = 0;
  const typed: string[] = [];

  const gridSess: any = {
    Accessibility: {
      enable: async () => {},
      getFullAXTree: async () => {
        axTreeCalls++;
        return {
          nodes: [
            { nodeId: "1", backendDOMNodeId: 101, role: { value: "gridcell" }, name: { value: "AA1" } },
            { nodeId: "2", backendDOMNodeId: 102, role: { value: "gridcell" }, name: { value: "AB2" } },
          ],
        };
      },
    },
    DOM: {
      pushNodesByBackendIdsToFrontend: async ({ backendNodeIds }: { backendNodeIds: number[] }) => ({ nodeIds: backendNodeIds }),
      getBoxModel: async ({ nodeId }: { nodeId: number }) => ({
        model: { content: [nodeId, 10, nodeId + 20, 10, nodeId + 20, 30, nodeId, 30] },
      }),
    },
    Input: {
      dispatchMouseEvent: async () => {},
      dispatchKeyEvent: async (ev: any) => {
        if (ev.type === "char" && ev.text) typed.push(ev.text);
      },
    },
  };

  const gridRes = await browserFill(
    gridSess,
    { grid_data: [{ cell: "AA1", value: "X" }, { cell: "AB2", value: "Y" }] },
    cfg
  );
  assert.equal(gridRes.success, true);
  assert.equal(gridRes.succeeded, 2);
  assert.equal(axTreeCalls, 1, "getFullAXTree must be called once per gridFill batch");
  assert.deepEqual(typed, ["X", "Y"]);

  // Verify blast_mode ARIA custom checkbox snippet does not double-click
  let blastExpr = "";
  const blastSess: any = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        blastExpr = expression;
        return { result: { value: JSON.stringify([{ ref: "#sw", ok: true, msg: "checked", type: "custom-checkbox", isSecret: false }]) } };
      },
    },
  };
  await browserFill(blastSess, { blast_mode: true, fields: [{ selector: "#sw", value: "true" }] }, cfg);
  const ariaBlock = blastExpr.slice(blastExpr.indexOf("ARIA custom checkbox"), blastExpr.indexOf("ARIA custom radio"));
  assert.ok(ariaBlock.includes("el.click()"));
  assert.ok(!ariaBlock.includes("new MouseEvent('click'"), "must not dispatch duplicate synthetic MouseEvent click after el.click()");
});

test("wait — network wait returns success:false on timeout when request stays in-flight", async () => {
  const ee = new EventEmitter();
  const sess: any = Object.assign(ee, {
    Network: { enable: async () => {} },
    Runtime: { evaluate: async () => ({ result: { value: null } }) },
  });

  const p = browserWait(sess, { for: "network", timeout: 1000 }, cfg);
  // Keep a request permanently in-flight so quiet timer never fires
  setTimeout(() => ee.emit("Network.requestWillBeSent", {}), 20);
  const res = await p;
  assert.equal(res.found, false);
  assert.equal(res.success, false, "timed-out network wait must report success: false");
});

test("scrape — 300ms retry reuses buildScrapeExpr preserving multiple:false and live value extraction", async () => {
  const exprs: string[] = [];
  let calls = 0;
  const sess: any = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        calls++;
        exprs.push(expression);
        if (calls === 1) return { result: { value: { data: [] } } };
        return { result: { value: { data: [{ value: "live-val" }] } } };
      },
    },
  };

  const res = await browserScrape(sess, { query: "input.name", attributes: ["value"], multiple: false }, cfg);
  assert.equal(res.success, true);
  assert.equal(calls, 2);
  assert.equal(exprs[0], exprs[1], "retry must reuse the exact same scrape expression");
  assert.ok(exprs[1].includes("attr === 'value'"));
  assert.deepEqual(res.data, [{ value: "live-val" }]);
});

test("navigate — Electron file:// skips cookie auto-click and populates fallback title", async () => {
  const evals: string[] = [];
  const url = "file:///C:/apps/demo/index.html";
  const tid = "electron-nav-tab";
  const ee = new EventEmitter();
  const sess: any = Object.assign(ee, {
    close: async () => {},
    Page: {
      enable: async () => {},
      navigate: async () => {
        setTimeout(() => ee.emit("Page.loadEventFired", {}), 10);
        return {};
      },
      bringToFront: async () => {},
      getFrameTree: async () => ({ frameTree: { frame: { url } } }),
    },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        evals.push(expression);
        if (expression === "document.title") return { result: { value: "" } };
        return { result: { value: "complete" } };
      },
    },
  });

  sessionRegistry.register(tid, { targetId: tid, session: sess, url, title: "", agentId: "default", isElectron: true } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    const res = await weaveNavigate(sess, url, cfg, tid);
    assert.equal(res.success, true);
    if (res.success) {
      assert.ok(res.title.length > 0, "file:// Electron title fallback must be non-empty");
    }
    assert.equal(evals.some(e => e.includes("cookiebanner")), false, "Electron navigation must not run web cookie-banner clicker");
  } finally {
    sessionRegistry.unregister(tid);
  }
});

test("tabs — WeavetabConsolidate respects Tab Armor locks and normalizes trailing slashes", async () => {
  const appName = "wt-unit-consolidate";
  const lockPath = getLockFilePath(appName);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ port: 9999, pid: process.pid }), "utf-8");

  const origList = CDP.List;
  const origClose = CDP.Close;
  const closedIds: string[] = [];
  let targets = [
    { id: "t1", type: "page", url: "https://example.com/page/" },
    { id: "t2", type: "page", url: "https://example.com/page" },   // duplicate (trailing slash diff) — should close
    { id: "t3", type: "page", url: "https://example.com/page/" },  // locked — must NOT close
  ];

  lockTab("t3");
  (CDP as any).List = async () => targets;
  (CDP as any).Close = async ({ id }: { id: string }) => {
    closedIds.push(id);
    targets = targets.filter(t => t.id !== id);
  };

  try {
    const res = await WeavetabConsolidate(cfg, appName);
    assert.equal(res.success, true);
    assert.deepEqual(closedIds, ["t2"], "must close normalized duplicate t2 while protecting locked tab t3");
    assert.equal(res.closed_duplicates, 1);
  } finally {
    unlockTab("t3");
    (CDP as any).List = origList;
    (CDP as any).Close = origClose;
    clearLock(appName);
  }
});
