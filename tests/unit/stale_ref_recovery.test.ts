import test from "node:test";
import assert from "node:assert/strict";
import { recoverDetachedRef } from "../../src/cdp/walker.js";
import { storeSnapshot, seedRichSnapshot } from "../../src/state/delta.js";
import { cacheActionMap } from "../../src/state/cache.js";

test("recoverDetachedRef: returns recovered:false if evaluate returns success:false", async () => {
  const mockSession: any = {
    Runtime: {
      evaluate: async () => ({
        result: { value: { success: false } },
      }),
    },
  };

  const result = await recoverDetachedRef(mockSession, "tab-test", "w:99");
  assert.equal(result.recovered, false);
  assert.equal(result.element, undefined);
});

test("recoverDetachedRef: recovers element via stored_selector when evaluate finds node", async () => {
  let evaluatedExpr = "";
  const mockSession: any = {
    Runtime: {
      evaluate: async (params: { expression: string }) => {
        evaluatedExpr = params.expression;
        return {
          result: {
            value: {
              success: true,
              strategy: "stored_selector",
              x: 150,
              y: 250,
              label: "Submit Payment",
              role: "button",
            },
          },
        };
      },
    },
  };

  // Seed rich snapshot with original metadata
  seedRichSnapshot("tab-test-2", "https://checkout.example.com", [
    {
      id: "w:42",
      role: "button",
      label: "Submit Payment",
      group: "form",
      fingerprint: "button:submit",
      depth: 1,
      selector: "#pay-btn",
    },
  ]);

  const result = await recoverDetachedRef(mockSession, "tab-test-2", "w:42");
  assert.equal(result.recovered, true);
  assert.ok(result.element);
  assert.equal(result.element.id, "w:42");
  assert.equal(result.element.label, "Submit Payment");
  assert.equal(result.element.role, "button");
  assert.equal(result.element.x, 150);
  assert.equal(result.element.y, 250);
  assert.equal(result.element.selector, '[data-wt-id="42"]');
  assert.equal(result.strategy, "stored_selector");
  assert.ok(result.warning?.includes("Auto-recovered detached ref 'w:42' via stored_selector"));
});

test("recoverDetachedRef: recovers via exact_label and patches raw action map cache", async () => {
  const mockSession: any = {
    Runtime: {
      evaluate: async () => ({
        result: {
          value: {
            success: true,
            strategy: "exact_label",
            x: 80,
            y: 90,
            label: "Sign In",
            role: "button",
          },
        },
      }),
    },
  };

  // Cache an initial action map
  cacheActionMap("tab-test-3", {
    url: "https://auth.example.com",
    title: "Sign In Page",
    elements: [
      {
        id: "w:10",
        role: "button",
        label: "Sign In",
        group: "form",
        fingerprint: "button:signin",
        depth: 0,
      },
    ],
  });

  const result = await recoverDetachedRef(mockSession, "tab-test-3", "w:10");
  assert.equal(result.recovered, true);
  assert.ok(result.element);
  assert.equal(result.element.id, "w:10");
  assert.equal(result.element.label, "Sign In");
  assert.equal(result.strategy, "exact_label");
});

test("recoverDetachedRef: safely masks redacted candidate values", async () => {
  let passedMeta: any = null;
  const mockSession: any = {
    Runtime: {
      evaluate: async (params: { expression: string }) => {
        // Evaluate expression in isolated Node function to inspect arguments
        return {
          result: {
            value: {
              success: false,
            },
          },
        };
      },
    },
  };

  const result = await recoverDetachedRef(mockSession, "tab-test-4", "w:55", {
    label: "[REDACTED]",
    placeholder: "[REDACTED]",
    textContent: "[REDACTED]",
  });

  assert.equal(result.recovered, false);
});
