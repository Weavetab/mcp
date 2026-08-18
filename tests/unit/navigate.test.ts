import test from "node:test";
import assert from "node:assert";
import { weaveNavigate } from "../../src/tools/navigate.js";

test("weaveNavigate - structure and exports", async (t) => {
  assert.ok(weaveNavigate, "weaveNavigate should be exported");
});
