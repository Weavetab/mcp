import test from "node:test";
import assert from "node:assert";
import { browserSelect, SelectOptions } from "../../src/tools/select.js";

test("browserSelect is exported", () => {
  assert.ok(browserSelect, "browserSelect should be exported");
});

test("browserSelect throws when both selector and nodeId are missing", async () => {
  const session: any = {
    DOM: {
      pushNodesByBackendIdsToFrontend: async () => { throw new Error("should not reach"); },
    },
  };
  const config: any = {};
  await assert.rejects(
    () => browserSelect(session, { value: "test" } as SelectOptions, config),
    /browser_select requires either selector or nodeId/
  );
});

test("browserSelect with selector delegates to getSelector", async () => {
  let callCount = 0;
  const session: any = {
    Runtime: {
      evaluate: async (_expr: any) => {
        const expr = typeof _expr === 'object' && _expr !== null ? _expr.expression || '' : String(_expr);
        if (expr.includes('dispatchEvent')) {
          return { result: { value: "selected:1" } };
        }
        if (expr.includes('querySelector')) {
          callCount++;
          const state = callCount <= 2
            ? { exists: "true", selectedIndex: "0", value: "old", selectedText: "Old" }
            : { exists: "true", selectedIndex: "1", value: "option1", selectedText: "Option1" };
          return { result: { value: JSON.stringify(state) } };
        }
        return { result: { value: "" } };
      },
    },
  };
  const config: any = {};
  const result = await browserSelect(session, { selector: "#my-select", value: "option1" }, config);
  assert.ok(result.success);
  assert.ok(result.message.includes("option1"));
});
