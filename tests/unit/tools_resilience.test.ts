import test from "node:test";
import assert from "node:assert/strict";
import { browserCookies } from "../../src/tools/cookies.js";
import { browserRecording } from "../../src/tools/recording.js";
import { browserInspect } from "../../src/tools/inspect.js";
import { browserSnapshot } from "../../src/tools/snapshot.js";
import { browserScreenshot } from "../../src/tools/screenshot.js";
import type { Config } from "../../src/config/loader.js";

const mockCfg = {} as Config;

test("browser_cookies — action: 'list' works as alias for 'get'", async () => {
  const mockSession: any = {
    Page: {
      getFrameTree: async () => ({
        frameTree: { frame: { url: "https://example.com" } }
      })
    },
    Network: {
      getCookies: async () => ({
        cookies: [
          { name: "token", value: "abc", domain: "example.com", path: "/", expires: 123456, httpOnly: true, secure: true }
        ]
      })
    }
  };

  const res = await browserCookies(mockSession, { action: "list" }, mockCfg);
  assert.equal(res.success, true);
  assert.equal(res.action, "get");
  assert.equal((res as any).count, 1);
  assert.equal((res as any).cookies[0].name, "token");
});

test("browser_recording — action: 'status' returns active status cleanly", async () => {
  const mockSession: any = {};
  const res = await browserRecording(mockSession, { action: "status" }, mockCfg);
  assert.equal(res.success, true);
  assert.equal(typeof res.active, "boolean");
  assert.equal(typeof res.count, "number");
  assert.ok(Array.isArray(res.recordings));
});

test("browser_inspect — throws descriptive error when element not found", async () => {
  const mockSession: any = {
    DOM: {
      enable: async () => {},
      getDocument: async () => ({}),
      describeNode: async () => null,
      requestNode: async () => null,
      getBoxModel: async () => null,
      resolveNode: async () => ({ object: {} })
    },
    CSS: {
      enable: async () => {},
      getComputedStyleForNode: async () => null
    },
    DOMDebugger: {
      getEventListeners: async () => ({ listeners: [] })
    },
    Runtime: {
      evaluate: async () => ({ result: { value: null } })
    }
  };

  await assert.rejects(
    async () => browserInspect(mockSession, { selector: ".missing-element" }, mockCfg),
    (err: Error) => {
      assert.match(err.message, /Element not found for selector: "\.missing-element"/);
      return true;
    }
  );
});

test("browser_inspect — query alias resolves to selector and succeeds via evaluate fallback", async () => {
  const mockSession: any = {
    DOM: {
      enable: async () => {},
      getDocument: async () => ({}),
      describeNode: async () => null,
      requestNode: async () => null, // simulates requestNode returning null
      getBoxModel: async () => null,
      resolveNode: async () => ({ object: {} })
    },
    CSS: {
      enable: async () => {},
      getComputedStyleForNode: async () => null
    },
    DOMDebugger: {
      getEventListeners: async () => ({ listeners: [] })
    },
    Runtime: {
      evaluate: async (params: { expression: string }) => {
        if (params.expression.includes("getBoundingClientRect")) {
          return {
            result: {
              value: JSON.stringify({ width: 120, height: 40, content: [10, 10, 130, 10, 130, 50, 10, 50] })
            }
          };
        }
        if (params.expression.includes("getComputedStyle")) {
          return {
            result: {
              value: JSON.stringify({ display: "block", color: "rgb(0, 0, 0)", "font-size": "16px" })
            }
          };
        }
        // element search evaluate
        return { result: { objectId: "remote-obj-123" } };
      }
    }
  };

  const res = await browserInspect(mockSession, { query: "#main-btn" }, mockCfg);
  assert.equal(res.success, true);
  assert.equal(res.data.boxModel.width, 120);
  assert.equal(res.data.computedStyles.display, "block");
});

test("browser_snapshot — action: 'capture' auto-generates timestamped filename when omitted", async () => {
  const mockSession: any = {
    Page: {
      captureSnapshot: async () => ({ data: "MHTML mock content" })
    },
    Runtime: {
      evaluate: async () => ({})
    }
  };

  const res = await browserSnapshot(mockSession, { action: "capture" }, mockCfg);
  assert.equal(res.success, true);
  assert.match(res.message, /Snapshot saved to/);
  assert.match(res.message, /snapshot-\d+\.mhtml/);
});

test("browser_screenshot — format 'base64' defaults to png cleanly", async () => {
  const mockSession: any = {
    Runtime: {
      evaluate: async () => ({
        result: { value: JSON.stringify({ w: 1280, h: 800, dpr: 1 }) }
      })
    },
    Page: {
      captureScreenshot: async (params: any) => {
        assert.equal(params.format, "png");
        return { data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" };
      }
    }
  };

  const res = await browserScreenshot(mockSession, { format: "base64" as any }, mockCfg);
  assert.equal(res.success, true);
  assert.equal(res.format, "png");
  assert.ok(res.dataUrl.startsWith("data:image/png;base64,"));
});
