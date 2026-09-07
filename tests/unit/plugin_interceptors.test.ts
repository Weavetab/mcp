import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { hookPipeline } from "../../src/plugin/pipeline.js";
import type { DOMMutationDelta } from "../../src/plugin/interface.js";

describe("Plugin Interceptor Middleware Hooks", () => {
  beforeEach(() => {
    hookPipeline.clearAllHooks();
  });

  describe("onBeforeAction", () => {
    it("intercepts and mutates tool arguments before execution", async () => {
      hookPipeline.registerPluginHooks("auth-injector", {
        onBeforeAction: async (tool, args) => {
          if (tool === "browser_navigate") {
            return {
              ...args,
              headers: { Authorization: "Bearer test-token-123" },
            };
          }
        },
      });

      const initialArgs = { url: "https://internal.corp.com" };
      const dispatchedArgs = await hookPipeline.dispatchBeforeToolCall("browser_navigate", initialArgs);

      assert.strictEqual(dispatchedArgs.url, "https://internal.corp.com");
      assert.deepStrictEqual(dispatchedArgs.headers, { Authorization: "Bearer test-token-123" });
    });

    it("blocks unauthorized tool calls with a descriptive error", async () => {
      hookPipeline.registerPluginHooks("ad-blocker", {
        onBeforeAction: async (tool, args) => {
          if (tool === "browser_navigate" && args.url?.includes("doubleclick.net")) {
            return { __blocked: true, reason: "Navigation to tracking domain blocked by policy" };
          }
        },
      });

      await assert.rejects(
        async () => {
          await hookPipeline.dispatchBeforeToolCall("browser_navigate", {
            url: "https://ad.doubleclick.net/tracker",
          });
        },
        (err: any) => {
          assert.strictEqual(err.isBlocked, true);
          assert.strictEqual(err.pluginName, "ad-blocker");
          assert.match(err.message, /Navigation to tracking domain blocked by policy/);
          return true;
        }
      );
    });

    it("chains multiple onBeforeAction middleware hooks in registration order", async () => {
      hookPipeline.registerPluginHooks("sanitizer", {
        onBeforeAction: async (_tool, args) => {
          return { ...args, query: args.query?.trim() };
        },
      });

      hookPipeline.registerPluginHooks("enhancer", {
        onBeforeAction: async (_tool, args) => {
          return { ...args, query: `${args.query} [enhanced]`, limit: 10 };
        },
      });

      const result = await hookPipeline.dispatchBeforeToolCall("search", { query: "  hello world  " });
      assert.strictEqual(result.query, "hello world [enhanced]");
      assert.strictEqual(result.limit, 10);
    });
  });

  describe("onAfterAction", () => {
    it("transforms or redacts tool results with clean (tool, result, session, args) signature", async () => {
      hookPipeline.registerPluginHooks("pii-scrubber", {
        onAfterAction: async (tool, result) => {
          if (tool === "browser_map" && typeof result === "object") {
            return {
              ...result,
              text: result.text?.replace(/SSN:\s*\d{3}-\d{2}-\d{4}/g, "SSN: [REDACTED]"),
            };
          }
        },
      });

      const rawResult = {
        title: "Account Overview",
        text: "User profile found. SSN: 000-12-3456 verified.",
      };

      const finalResult = await hookPipeline.dispatchAfterToolCall("browser_map", {}, rawResult);
      assert.strictEqual(finalResult.title, "Account Overview");
      assert.strictEqual(finalResult.text, "User profile found. SSN: [REDACTED] verified.");
    });

    it("retains backward compatibility with legacy 4-param afterToolCall hooks", async () => {
      hookPipeline.registerPluginHooks("legacy-logger", {
        afterToolCall: async (tool, args, result) => {
          return { ...result, capturedBy: "legacy", target: args.selector };
        },
      });

      const result = await hookPipeline.dispatchAfterToolCall(
        "browser_click",
        { selector: "#submit-btn" },
        { status: "ok" }
      );
      assert.strictEqual(result.status, "ok");
      assert.strictEqual(result.capturedBy, "legacy");
      assert.strictEqual(result.target, "#submit-btn");
    });
  });

  describe("onDOMMutation", () => {
    it("broadcasts DOM mutation deltas to registered plugins", async () => {
      const receivedDeltas: DOMMutationDelta[] = [];

      hookPipeline.registerPluginHooks("mutation-tracker", {
        onDOMMutation: async (delta) => {
          receivedDeltas.push(delta);
        },
      });

      const mockDelta: DOMMutationDelta = {
        type: "dom_diff",
        timestamp: Date.now(),
        url: "https://example.com",
        added: [{ id: "w:1", role: "button", label: "Save Changes" }],
        removed: [],
        changed: [{ ref: "w:2", attribute: "disabled", oldValue: "true", newValue: "false" }],
        significantChange: true,
      };

      await hookPipeline.dispatchDOMMutation(mockDelta);

      assert.strictEqual(receivedDeltas.length, 1);
      assert.strictEqual(receivedDeltas[0].type, "dom_diff");
      assert.strictEqual(receivedDeltas[0].added?.[0].label, "Save Changes");
      assert.strictEqual(receivedDeltas[0].changed?.[0].newValue, "false");
    });
  });

  describe("Lifecycle & Cleanup", () => {
    it("unregisters all hooks cleanly when plugin unloads", async () => {
      hookPipeline.registerPluginHooks("ephemeral-plugin", {
        onBeforeAction: async (_tool, args) => ({ ...args, intercepted: true }),
        onAfterAction: async (_tool, result) => ({ ...result, postProcessed: true }),
        onDOMMutation: async () => {},
      });

      let beforeRes = await hookPipeline.dispatchBeforeToolCall("test", {});
      assert.strictEqual(beforeRes.intercepted, true);

      hookPipeline.unregisterPluginHooks("ephemeral-plugin");

      beforeRes = await hookPipeline.dispatchBeforeToolCall("test", {});
      assert.strictEqual(beforeRes.intercepted, undefined);

      const afterRes = await hookPipeline.dispatchAfterToolCall("test", {}, { original: true });
      assert.strictEqual(afterRes.postProcessed, undefined);
      assert.strictEqual(afterRes.original, true);
    });
  });
});
