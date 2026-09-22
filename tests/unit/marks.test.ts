import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  marksSet,
  marksGet,
  marksInvalidate,
  marksGetAll,
  type MarkEntry
} from "../../src/intelligence/marks.js";

describe("Visual Grounding Marks System", () => {
  test("stores and retrieves mark entries by number", () => {
    const targetId = "test-tab-1";
    const sampleMarks = new Map<number, MarkEntry>([
      [1, { x: 150, y: 200, width: 80, height: 32, ref: "w:1", label: "Submit", type: "button" }],
      [2, { x: 300, y: 450, width: 200, height: 40, ref: "w:2", label: "Email", type: "input" }],
      [3, { x: 500, y: 100, width: 50, height: 50, type: "canvas_region" }]
    ]);

    marksSet(targetId, sampleMarks);

    const mark1 = marksGet(targetId, 1);
    assert.ok(mark1);
    assert.equal(mark1.x, 150);
    assert.equal(mark1.y, 200);
    assert.equal(mark1.label, "Submit");
    assert.equal(mark1.ref, "w:1");

    const mark3 = marksGet(targetId, 3);
    assert.ok(mark3);
    assert.equal(mark3.type, "canvas_region");
    assert.equal(mark3.ref, undefined);

    const nonExistent = marksGet(targetId, 99);
    assert.equal(nonExistent, null);
  });

  test("isolates marks by targetId", () => {
    const tabA = "tab-A";
    const tabB = "tab-B";

    marksSet(tabA, new Map([[1, { x: 10, y: 10, width: 20, height: 20 }]]));
    marksSet(tabB, new Map([[1, { x: 99, y: 99, width: 50, height: 50 }]]));

    assert.equal(marksGet(tabA, 1)?.x, 10);
    assert.equal(marksGet(tabB, 1)?.x, 99);
  });

  test("invalidates marks on page navigation", () => {
    const targetId = "nav-tab";
    marksSet(targetId, new Map([[1, { x: 100, y: 100, width: 30, height: 30 }]]));
    assert.ok(marksGet(targetId, 1));

    marksInvalidate(targetId);
    assert.equal(marksGet(targetId, 1), null);
    assert.equal(marksGetAll(targetId).size, 0);
  });
});
