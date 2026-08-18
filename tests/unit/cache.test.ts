/**
 * cache.test.ts — Phase 1.1
 * Unit tests for action map and box model caching with mutation-based TTL invalidation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCachedActionMap,
  cacheActionMap,
  cacheBoxModel,
  getCachedBoxModel,
  cacheNode,
  getCachedNode,
  clearTabCache,
} from "../../src/state/cache.js";

test("cache: basic action map storage and retrieval", () => {
  const targetId = "tab-1";
  const mockMap = { url: "https://example.com", elements: [] } as any;

  clearTabCache(targetId);
  assert.equal(getCachedActionMap(targetId), null, "Initial cache miss");

  cacheActionMap(targetId, mockMap);
  const retrieved = getCachedActionMap(targetId);
  assert.ok(retrieved !== null, "Cache hit after storage");
  assert.equal(retrieved?.url, "https://example.com");

  clearTabCache(targetId);
});

test("cache: URL validation prevents stale cache", () => {
  const targetId = "tab-2";
  const mockMap = { url: "https://example.com", elements: [] } as any;

  cacheActionMap(targetId, mockMap);
  assert.ok(getCachedActionMap(targetId, "https://example.com") !== null);
  assert.equal(getCachedActionMap(targetId, "https://other.com"), null);

  clearTabCache(targetId);
});

test("cache: box model storage and retrieval", () => {
  const targetId = "tab-3";
  const backendNodeId = 12345;
  const mockBoxModel = { model: { content: [0, 0, 100, 100] } };

  cacheActionMap(targetId, { url: "https://example.com", elements: [] } as any);
  cacheBoxModel(targetId, backendNodeId, mockBoxModel);
  const retrieved = getCachedBoxModel(targetId, backendNodeId);
  assert.ok(retrieved !== null, "Box model cached");
  assert.deepEqual(retrieved, mockBoxModel);

  clearTabCache(targetId);
});

test("cache: node storage and retrieval", () => {
  const targetId = "tab-4";
  const backendNodeId = 67890;
  const mockNode = { nodeId: 67890, nodeName: "DIV" };

  cacheActionMap(targetId, { url: "https://example.com", elements: [] } as any);
  cacheNode(targetId, backendNodeId, mockNode);
  const retrieved = getCachedNode(targetId, backendNodeId);
  assert.ok(retrieved !== null, "Node cached");
  assert.deepEqual(retrieved, mockNode);

  clearTabCache(targetId);
});

test("cache: clearTabCache removes all cached data", () => {
  const targetId = "tab-5";
  const mockMap = { url: "https://example.com", elements: [] } as any;
  const mockBoxModel = { model: { content: [0, 0, 100, 100] } };

  cacheActionMap(targetId, mockMap);
  cacheBoxModel(targetId, 12345, mockBoxModel);

  assert.ok(getCachedActionMap(targetId) !== null);
  assert.ok(getCachedBoxModel(targetId, 12345) !== null);

  clearTabCache(targetId);

  assert.equal(getCachedActionMap(targetId), null);
  assert.equal(getCachedBoxModel(targetId, 12345), null);
});

test("cache: missing cache returns null without error", () => {
  assert.equal(getCachedActionMap("nonexistent-tab"), null);
  assert.equal(getCachedBoxModel("nonexistent-tab", 999), null);
  assert.equal(getCachedNode("nonexistent-tab", 999), null);
});
