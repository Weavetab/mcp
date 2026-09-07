/**
 * Weavetab — tests/unit/checkpoint.test.ts
 * Unit tests for browser_checkpoint tool.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { browserCheckpoint, clearAllCheckpoints, getCheckpointsForTarget } from "../../src/tools/checkpoint.js";
import { validateConfigInternal } from "../../src/config/loader.js";

describe("browser_checkpoint (Session Time-Travel)", () => {
  const dummyConfig = validateConfigInternal({});

  // Mock CDP Client session
  function createMockSession(initialUrl = "https://example.com/checkout") {
    let currentUrl = initialUrl;
    let evalLog: string[] = [];
    let setCookiesCall: any = null;

    const session: any = {
      Page: {
        getFrameTree: async () => ({
          frameTree: { frame: { url: currentUrl } },
        }),
        navigate: async ({ url }: { url: string }) => {
          currentUrl = url;
          return {};
        },
        loadEventFired: async () => ({}),
      },
      Network: {
        getCookies: async () => ({
          cookies: [{ name: "session_id", value: "abc123xyz", domain: "example.com", path: "/" }],
        }),
        setCookies: async (params: any) => {
          setCookiesCall = params;
          return {};
        },
      },
      Runtime: {
        evaluate: async ({ expression, returnByValue }: { expression: string; returnByValue: boolean }) => {
          evalLog.push(expression);
          if (returnByValue) {
            return {
              result: {
                value: {
                  localStorage: { auth_token: "jwt_token_val", cart: "items_json" },
                  sessionStorage: { step: "payment" },
                  scroll: { x: 0, y: 350 },
                  title: "Checkout - Step 2",
                },
              },
            };
          }
          return {};
        },
      },
      _getState: () => ({ currentUrl, evalLog, setCookiesCall }),
    };

    return session;
  }

  beforeEach(() => {
    clearAllCheckpoints();
  });

  it("fails when name is missing for save, restore, or delete", async () => {
    const session = createMockSession();

    const saveRes = await browserCheckpoint(session, { action: "save" }, dummyConfig);
    assert.strictEqual(saveRes.success, false);
    assert.strictEqual(saveRes.error_code, "INVALID_ARGS");

    const restoreRes = await browserCheckpoint(session, { action: "restore" }, dummyConfig);
    assert.strictEqual(restoreRes.success, false);
    assert.strictEqual(restoreRes.error_code, "INVALID_ARGS");

    const deleteRes = await browserCheckpoint(session, { action: "delete" }, dummyConfig);
    assert.strictEqual(deleteRes.success, false);
    assert.strictEqual(deleteRes.error_code, "INVALID_ARGS");
  });

  it("saves a named checkpoint capturing storage, cookies, and url", async () => {
    const session = createMockSession("https://example.com/checkout");

    const res = await browserCheckpoint(
      session,
      { action: "save", name: "before_payment" },
      dummyConfig
    );

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.name, "before_payment");
    assert.strictEqual(res.url, "https://example.com/checkout");
    assert.strictEqual(res.cookiesCount, 1);
    assert.strictEqual(res.localStorageKeysCount, 2);
    assert.strictEqual(res.sessionStorageKeysCount, 1);

    const cp = getCheckpointsForTarget("default").get("before_payment");
    assert.ok(cp);
    assert.strictEqual(cp.title, "Checkout - Step 2");
    assert.strictEqual(cp.localStorage.auth_token, "jwt_token_val");
  });

  it("lists all saved checkpoints", async () => {
    const session = createMockSession();

    await browserCheckpoint(session, { action: "save", name: "step1" }, dummyConfig);
    await browserCheckpoint(session, { action: "save", name: "step2" }, dummyConfig);

    const listRes = await browserCheckpoint(session, { action: "list" }, dummyConfig);
    assert.strictEqual(listRes.success, true);
    assert.strictEqual(listRes.count, 2);
    assert.strictEqual(listRes.checkpoints.length, 2);
    assert.strictEqual(listRes.checkpoints[0].name, "step1");
    assert.strictEqual(listRes.checkpoints[1].name, "step2");
  });

  it("restores checkpoint and rolls back page state and cookies", async () => {
    const session = createMockSession("https://example.com/checkout");

    // Save initial checkpoint
    await browserCheckpoint(session, { action: "save", name: "checkpoint_alpha" }, dummyConfig);

    // Simulate navigation to failed page
    session.Page.navigate({ url: "https://example.com/failed-payment" });

    // Restore checkpoint
    const restoreRes = await browserCheckpoint(
      session,
      { action: "restore", name: "checkpoint_alpha" },
      dummyConfig
    );

    assert.strictEqual(restoreRes.success, true);
    assert.strictEqual(restoreRes.name, "checkpoint_alpha");
    assert.strictEqual(restoreRes.url, "https://example.com/checkout");

    // Verify session navigated back to original checkpoint URL
    const state = session._getState();
    assert.strictEqual(state.currentUrl, "https://example.com/checkout");
    assert.ok(state.setCookiesCall);
    assert.strictEqual(state.setCookiesCall.cookies[0].name, "session_id");
  });

  it("deletes a checkpoint successfully", async () => {
    const session = createMockSession();

    await browserCheckpoint(session, { action: "save", name: "temp" }, dummyConfig);
    assert.strictEqual(getCheckpointsForTarget("default").has("temp"), true);

    const delRes = await browserCheckpoint(session, { action: "delete", name: "temp" }, dummyConfig);
    assert.strictEqual(delRes.success, true);
    assert.strictEqual(getCheckpointsForTarget("default").has("temp"), false);
  });
});
