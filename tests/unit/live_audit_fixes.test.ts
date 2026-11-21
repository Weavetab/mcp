import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { weaveClick } from "../../src/tools/click.js";
import { weaveType } from "../../src/tools/type.js";
import { browserViewport } from "../../src/tools/viewport.js";
import { browserPointer } from "../../src/tools/pointer.js";
import { browserSnapshot } from "../../src/tools/snapshot.js";
import { browserNetworkIntercept, cleanupNetworkIntercept } from "../../src/tools/network_intercept.js";
import { sessionRegistry } from "../../src/state/session.js";
import { clearTabCache } from "../../src/state/cache.js";

const cfg = { agentId: "default", headless: true, role: "operator" } as any;

test("extension HUD avoids color-scheme mismatch whiteout and uses dedicated host id", () => {
  const hudHtml = fs.readFileSync(path.resolve("ext-dist/hud/index.html"), "utf-8");
  const contentJs = fs.readFileSync(path.resolve("ext-dist/content.js"), "utf-8");
  assert.match(hudHtml, /color-scheme:\s*normal/i);
  assert.match(contentJs, /colorScheme:\s*['"]normal['"]/);
  assert.match(contentJs, /__wt_hud_host/);
});

test("browser_click suggests force:true on occlusion and bypasses when force=true", async () => {
  const tid = "live-click-force";
  const url = "https://github.com/Weavetab/mcp";
  const clicks: string[] = [];

  const sess: any = {
    close: async () => {},
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url } } }) },
    DOM: { getDocument: async () => ({ root: { nodeId: 1 } }), pushNodesByBackendIdsToFrontend: async () => ({ nodeIds: [] }) },
    Input: {
      dispatchMouseEvent: async (ev: any) => {
        clicks.push(ev.type);
      },
    },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        if (expression.includes("isWtOwned") && expression.includes("elementsFromPoint")) {
          return {
            result: {
              value: {
                status: "OCCLUDED",
                x: 120,
                y: 80,
                occludedBy: { tag: "div", id: "_R_27d_", className: "Dropdown", ariaLabel: null, isWeavetabOwned: false },
              },
            },
          };
        }
        return { result: { value: null } };
      },
    },
  };

  sessionRegistry.register(tid, { targetId: tid, session: sess, url, title: "GitHub", agentId: "default" } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    const blocked = await weaveClick(sess, { id: "#blocked-btn" }, cfg);
    assert.equal(blocked.success, false);
    assert.equal((blocked as any).error_code, "ELEMENT_OCCLUDED_BY");
    assert.match((blocked as any).suggestion ?? "", /force:\s*true/);

    const forced = await weaveClick(sess, { id: "#blocked-btn", force: true }, cfg);
    assert.equal(forced.success, true);
    assert.ok(clicks.includes("mousePressed") && clicks.includes("mouseReleased"));
  } finally {
    sessionRegistry.unregister(tid);
    clearTabCache(tid);
  }
});

test("browser_type honors clear alias even for >8 char inputs on selector fallback", async () => {
  const tid = "live-type-clear";
  const url = "https://en.wikipedia.org/wiki/Main_Page";
  const evalExprs: string[] = [];
  let pasted = false;

  const sess: any = {
    close: async () => {},
    Page: { getFrameTree: async () => ({ frameTree: { frame: { url } } }) },
    DOM: { getDocument: async () => ({ root: { nodeId: 1 } }) },
    Input: {
      dispatchMouseEvent: async () => {},
      dispatchKeyEvent: async () => {},
      insertText: async () => {
        pasted = true;
      },
    },
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        evalExprs.push(expression);
        if (expression.includes("isContentEditable") && expression.includes("spinbutton")) {
          return { result: { value: true } };
        }
        if (expression.includes("getBoundingClientRect") && expression.includes("selector-match")) {
          return { result: { value: { label: "Search Wikipedia", x: 100, y: 40 } } };
        }
        if (expression.includes("activeElement")) return { result: { value: true } };
        if (expression.includes("reactFiber")) return { result: { value: "vanilla" } };
        return { result: { value: null } };
      },
    },
  };

  sessionRegistry.register(tid, { targetId: tid, session: sess, url, title: "Wiki", agentId: "default", isElectron: true } as any);
  sessionRegistry.setActive(tid, "default");

  try {
    const res = await weaveType(sess, { id: "#searchInput", text: "Quantum computing", clear: true, fast: true }, cfg);
    assert.equal(res.success, true);
    assert.ok(evalExprs.some((e) => e.includes("nativeSetter.call(el, '')")));
    assert.equal(pasted, true);
  } finally {
    sessionRegistry.unregister(tid);
    clearTabCache(tid);
  }
});

test("viewport, pointer, snapshot, and network_intercept accept ergonomic inputs", async () => {
  const calls: string[] = [];
  const sess: any = {
    Emulation: {
      setDeviceMetricsOverride: async (p: any) => { calls.push(`metrics:${p.width}x${p.height}`); },
      setTouchEmulationEnabled: async () => {},
    },
    Network: {
      setUserAgentOverride: async () => {},
    },
    Page: {
      getFrameTree: async () => ({ frameTree: { frame: { url: "https://example.org" } } }),
      captureSnapshot: async () => ({ data: "MHTML" }),
    },
    Input: {
      dispatchMouseEvent: async (ev: any) => { calls.push(`mouse:${ev.type}`); },
    },
    Runtime: {
      evaluate: async () => ({ result: { value: false } }),
    },
    Fetch: {
      enable: async (p: any) => { calls.push(`fetch:${p.patterns[0].urlPattern}`); },
    },
    on: () => {},
  };

  const vpRes = await browserViewport(sess, { preset: "Desktop 1920x1080" }, cfg);
  assert.equal(vpRes.success, true);
  assert.ok(calls.includes("metrics:1920x1080"));

  const ptrRes = await browserPointer(sess, { action: "move", x: 50, y: 60 }, cfg);
  assert.equal(ptrRes.success, true);
  assert.equal(ptrRes.action, "move");
  assert.ok(calls.includes("mouse:mouseMoved"));

  const snapPath = path.join(path.resolve("snapshots-test"), "ergo-snap.mhtml");
  try {
    const snapRes = await browserSnapshot(sess, { filePath: snapPath }, cfg);
    assert.equal(snapRes.success, true);
  } finally {
    fs.rmSync(path.resolve("snapshots-test"), { recursive: true, force: true });
  }

  const netRes = await browserNetworkIntercept(
    sess,
    { action: "enable", rules: [{ pattern: "*api/v1/*" }] },
    cfg
  );
  assert.equal(netRes.success, true);
  assert.ok(calls.includes("fetch:*api/v1/*"));
  cleanupNetworkIntercept(sess);
});

test("MCP stdio server exits promptly on stdin EOF without leaving zombie node processes", async () => {
  const entry = path.resolve("dist/index.js");
  if (!fs.existsSync(entry)) return;

  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, WT_SKIP_UPDATE_CHECK: "1" },
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("server did not report ready in 10s")), 10_000);
      let errBuf = "";
      child.stderr.on("data", (d) => {
        errBuf += d.toString();
        if (errBuf.includes("Weavetab Server Ready")) {
          clearTimeout(t);
          resolve();
        }
      });
      child.on("exit", (code) => {
        clearTimeout(t);
        reject(new Error(`server exited prematurely with code ${code}: ${errBuf}`));
      });
    });

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("zombie node process did not exit within 4s after stdin EOF")), 4000);
      child.once("exit", (code) => {
        clearTimeout(t);
        resolve(code);
      });
      child.stdin.end();
    });

    assert.equal(exitCode, 0);
  } finally {
    try { child.kill(); } catch {}
  }
});
