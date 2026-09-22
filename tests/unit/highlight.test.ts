import test from "node:test";
import assert from "node:assert";
import { browserHighlight, HighlightOptions } from "../../src/tools/highlight.js";

test("browserHighlight - export and interface verification", async () => {
  assert.strictEqual(typeof browserHighlight, "function", "browserHighlight must be an exported function");
});

test("browserHighlight - multi-ref evaluation and styling", async () => {
  const evaluatedExpressions: string[] = [];
  const mockSession: any = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        evaluatedExpressions.push(expression);
        return { result: { value: true } };
      }
    },
    DOM: {
      pushNodesByBackendIdsToFrontend: async () => ({ nodeIds: [100] }),
      getBoxModel: async () => ({
        model: { content: [10, 20, 110, 20, 110, 60, 10, 60] }
      })
    }
  };

  const mockConfig: any = { agentId: "test-agent" };

  const options: HighlightOptions = {
    refs: ["w:10", "w:20", "w:30"],
    style: "consideration",
    label: "Candidate form field",
    duration: 1500
  };

  const res = await browserHighlight(mockSession, options, mockConfig);
  assert.strictEqual(res.success, true);
  assert.match(res.message, /Highlighted 3\/3 element\(s\) with style 'consideration' \(1500ms\)/);

  assert.ok(
    evaluatedExpressions.some(e => e.includes("wt-consider-pulse")),
    "Should inject wt-consider-pulse keyframe"
  );
  assert.ok(
    evaluatedExpressions.some(e => e.includes("Candidate form field")),
    "Should include custom label in injected overlay"
  );
});

test("browserHighlight - target lock style single ref", async () => {
  const evaluatedExpressions: string[] = [];
  const mockSession: any = {
    Runtime: {
      evaluate: async ({ expression }: { expression: string }) => {
        evaluatedExpressions.push(expression);
        return { result: { value: true } };
      }
    }
  };

  const mockConfig: any = { agentId: "test-agent" };

  const options: HighlightOptions = {
    ref: "w:42",
    style: "target",
    duration: 2500
  };

  const res = await browserHighlight(mockSession, options, mockConfig);
  assert.strictEqual(res.success, true);
  assert.match(res.message, /Highlighted w:42 with style 'target' \(2500ms\)/);
});
