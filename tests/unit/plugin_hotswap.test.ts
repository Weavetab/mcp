import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { PluginRuntime } from "../../src/plugin/runtime.js";
import { hookPipeline } from "../../src/plugin/pipeline.js";
import { createSurface } from "../../src/plugin/surface.js";
import { invalidatePluginModuleCache } from "../../src/plugin/loader.js";

function makeFakeMcpServer() {
  const registeredTools: Record<string, any> = {};
  const registeredResources: Record<string, any> = {};
  const registeredPrompts: Record<string, any> = {};

  const server = {
    _registeredTools: registeredTools,
    _registeredResources: registeredResources,
    _registeredPrompts: registeredPrompts,
    server: {
      _instructions: "",
      sendToolListChanged: async () => {},
      sendPromptListChanged: async () => {},
      sendResourceListChanged: async () => {},
    },
    tool: (name: string, ...rest: any[]) => {
      const handler = rest[rest.length - 1];
      const desc = typeof rest[0] === "string" ? rest[0] : "";
      registeredTools[name] = { name, description: desc, handler };
      return registeredTools[name];
    },
    registerResource: (name: string, uri: string, meta: any, cb: any) => {
      registeredResources[uri] = { name, uri, meta, cb, enabled: true };
      return {
        remove: () => {
          delete registeredResources[uri];
        },
      };
    },
    registerPrompt: (name: string, desc: string, ...rest: any[]) => {
      const cb = rest[rest.length - 1];
      registeredPrompts[name] = { name, desc, cb };
      return {
        remove: () => {
          delete registeredPrompts[name];
        },
      };
    },
    prompt: (name: string, desc: string, cb: any) => {
      registeredPrompts[name] = { name, desc, cb };
      return {
        remove: () => {
          delete registeredPrompts[name];
        },
      };
    },
  };
  return server as any;
}

function makeTmpPlugin(manifest: object, code: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-hotswap-test-"));
  fs.writeFileSync(path.join(tmpDir, "weavetab.json"), JSON.stringify(manifest, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({
      name: (manifest as any).name,
      version: (manifest as any).version || "1.0.0",
      main: "index.js",
    }),
    "utf-8"
  );
  fs.writeFileSync(path.join(tmpDir, "index.js"), code, "utf-8");
  return tmpDir;
}

describe("Plugin Hot-Swap Runtime (PluginRuntime)", () => {
  beforeEach(() => {
    hookPipeline.clearAllHooks();
  });

  it("snapshots built-in tools baseline and restores overridden tools cleanly", async () => {
    const fakeServer = makeFakeMcpServer();
    let baselineCalled = false;
    fakeServer.tool("browser_click", "Baseline click", {}, async () => {
      baselineCalled = true;
      return { baseline: true };
    });

    const surface = createSurface(fakeServer, () => ({}) as any, () => {});
    const runtime = new PluginRuntime({
      server: fakeServer,
      config: { agentId: "test" } as any,
      surface,
      verifiedPackages: new Set(["wt-override-test"]),
      callbacks: {
        withSecurity: async (_cfg, _t, fn) => fn({}, {} as any),
        createTabProxy: () => ({}),
        normalizeToolResult: (res) => res,
        wrapError: (e) => ({ isError: true, error: String(e) }),
      },
    });

    runtime.snapshotBaseline();
    assert.ok(fakeServer._registeredTools["browser_click"]);

    // Plugin overrides browser_click
    const pluginDir = makeTmpPlugin(
      {
        name: "wt-override-test",
        version: "1.0.0",
        permissions: { tools: { override: ["browser_click"] } },
      },
      `
      module.exports = {
        name: "wt-override-test",
        version: "1.0.0",
        overrides: [
          {
            name: "browser_click",
            description: "Overridden click",
            handler: async (args, session, config, orig) => {
              const prev = orig ? await orig(args) : null;
              return { overridden: true, prev };
            }
          }
        ]
      };
      `
    );

    const loaded = await runtime.loadPlugin(pluginDir);
    assert.strictEqual(loaded, true);
    assert.strictEqual(fakeServer._registeredTools["browser_click"].description, "Overridden click");

    // Execute overridden tool
    const overrideRes = await fakeServer._registeredTools["browser_click"].handler({});
    assert.strictEqual(overrideRes.overridden, true);
    assert.strictEqual(overrideRes.prev.baseline, true);

    // Unload plugin — should restore baseline pristine definition
    await runtime.unloadPlugin("wt-override-test");
    assert.strictEqual(fakeServer._registeredTools["browser_click"].description, "Baseline click");
    baselineCalled = false;
    const restoredRes = await fakeServer._registeredTools["browser_click"].handler({});
    assert.strictEqual(restoredRes.baseline, true);
    assert.strictEqual(baselineCalled, true);

    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  it("restores built-in tools removed by a plugin", async () => {
    const fakeServer = makeFakeMcpServer();
    fakeServer.tool("browser_eval", "Eval tool", {}, async () => ({ res: 42 }));

    const surface = createSurface(fakeServer, () => ({}) as any, () => {});
    const runtime = new PluginRuntime({
      server: fakeServer,
      config: { agentId: "test" } as any,
      surface,
      verifiedPackages: new Set(["wt-remove-test"]),
      callbacks: {
        withSecurity: async (_cfg, _t, fn) => fn({}, {} as any),
        createTabProxy: () => ({}),
        normalizeToolResult: (res) => res,
        wrapError: (e) => ({ isError: true, error: String(e) }),
      },
    });

    runtime.snapshotBaseline();
    assert.ok(fakeServer._registeredTools["browser_eval"]);

    // Plugin removes browser_eval
    const pluginDir = makeTmpPlugin(
      {
        name: "wt-remove-test",
        version: "1.0.0",
        permissions: { tools: { remove: ["browser_eval"] } },
      },
      `
      module.exports = {
        name: "wt-remove-test",
        version: "1.0.0",
        removeTools: ["browser_eval"]
      };
      `
    );

    await runtime.loadPlugin(pluginDir);
    assert.strictEqual(fakeServer._registeredTools["browser_eval"], undefined);

    // Unload — baseline restores it
    await runtime.unloadPlugin("wt-remove-test");
    assert.ok(fakeServer._registeredTools["browser_eval"]);
    assert.strictEqual(fakeServer._registeredTools["browser_eval"].description, "Eval tool");

    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  it("cleans up dynamic tools registered via ctx.mcp.registerTool on unload", async () => {
    const fakeServer = makeFakeMcpServer();
    const surface = createSurface(fakeServer, () => ({}) as any, () => {});
    const runtime = new PluginRuntime({
      server: fakeServer,
      config: { agentId: "test" } as any,
      surface,
      verifiedPackages: new Set(["wt-dyn-test"]),
      callbacks: {
        withSecurity: async (_cfg, _t, fn) => fn({}, {} as any),
        createTabProxy: () => ({}),
        normalizeToolResult: (res) => res,
        wrapError: (e) => ({ isError: true, error: String(e) }),
      },
    });

    runtime.snapshotBaseline();

    const pluginDir = makeTmpPlugin(
      {
        name: "wt-dyn-test",
        version: "1.0.0",
        permissions: { tools: { add: true } },
      },
      `
      module.exports = {
        name: "wt-dyn-test",
        version: "1.0.0",
        async onLoad(ctx) {
          ctx.mcp.registerTool({
            name: "dynamic_status",
            description: "A dynamic tool added in onLoad",
            schema: {},
            handler: async () => ({ dynamic: true })
          });
        }
      };
      `
    );

    const loaded = await runtime.loadPlugin(pluginDir);
    assert.strictEqual(loaded, true);
    assert.ok(fakeServer._registeredTools["dynamic_status"]);

    const runRes = await fakeServer._registeredTools["dynamic_status"].handler({});
    assert.strictEqual(runRes.dynamic, true);

    // Unload — dynamic tool must NOT become a ghost tool
    await runtime.unloadPlugin("wt-dyn-test");
    assert.strictEqual(fakeServer._registeredTools["dynamic_status"], undefined);

    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  it("unregisters hooks and cleans surface items on unload", async () => {
    const fakeServer = makeFakeMcpServer();
    const surface = createSurface(fakeServer, () => ({}) as any, () => {});
    const runtime = new PluginRuntime({
      server: fakeServer,
      config: { agentId: "test" } as any,
      surface,
      verifiedPackages: new Set(["wt-hook-surface-test"]),
      callbacks: {
        withSecurity: async (_cfg, _t, fn) => fn({}, {} as any),
        createTabProxy: () => ({}),
        normalizeToolResult: (res) => res,
        wrapError: (e) => ({ isError: true, error: String(e) }),
      },
    });

    runtime.snapshotBaseline();

    (global as any).__testHookFired = false;
    const pluginDir = makeTmpPlugin(
      {
        name: "wt-hook-surface-test",
        version: "1.0.0",
        permissions: { prompts: { add: true }, resources: { add: true } },
      },
      `
      module.exports = {
        name: "wt-hook-surface-test",
        version: "1.0.0",
        prompts: [{ name: "my_prompt", description: "p", handler: async () => "p" }],
        resources: [{ name: "my_resource", uri: "myplugin://test/res", read: async () => "r" }],
        hooks: {
          beforeToolCall: [
            async () => {
              global.__testHookFired = true;
              return {};
            }
          ]
        }
      };
      `
    );

    await runtime.loadPlugin(pluginDir);

    // Verify prompt & resource mounted on surface
    assert.strictEqual(surface.count().prompts, 1);
    assert.strictEqual(surface.count().resources, 1);

    // Verify hook fires
    await hookPipeline.dispatchBeforeToolCall("any_tool", {});
    assert.strictEqual((global as any).__testHookFired, true);

    // Unload plugin
    (global as any).__testHookFired = false;
    await runtime.unloadPlugin("wt-hook-surface-test");

    // Hook must not fire anymore
    await hookPipeline.dispatchBeforeToolCall("any_tool", {});
    assert.strictEqual((global as any).__testHookFired, false);

    // Surface items dropped
    assert.strictEqual(surface.count().prompts, 0);
    assert.strictEqual(surface.count().resources, 0);

    fs.rmSync(pluginDir, { recursive: true, force: true });
  });

  it("invalidates require cache on reload when code changes on disk", async () => {
    const fakeServer = makeFakeMcpServer();
    const surface = createSurface(fakeServer, () => ({}) as any, () => {});
    const runtime = new PluginRuntime({
      server: fakeServer,
      config: { agentId: "test" } as any,
      surface,
      verifiedPackages: new Set(["wt-cache-test"]),
      callbacks: {
        withSecurity: async (_cfg, _t, fn) => fn({}, {} as any),
        createTabProxy: () => ({}),
        normalizeToolResult: (res) => res,
        wrapError: (e) => ({ isError: true, error: String(e) }),
      },
    });

    runtime.snapshotBaseline();

    const pluginDir = makeTmpPlugin(
      {
        name: "wt-cache-test",
        version: "1.0.0",
        permissions: { tools: { add: true } },
      },
      `
      module.exports = {
        name: "wt-cache-test",
        version: "1.0.0",
        tools: [
          {
            name: "test_val",
            description: "Returns val",
            handler: async () => ({ val: "version_1" })
          }
        ]
      };
      `
    );

    await runtime.loadPlugin(pluginDir);
    const res1 = await fakeServer._registeredTools["test_val"].handler({});
    assert.strictEqual(res1.val, "version_1");

    // Rewrite code on disk
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      `
      module.exports = {
        name: "wt-cache-test",
        version: "2.0.0",
        tools: [
          {
            name: "test_val",
            description: "Returns val",
            handler: async () => ({ val: "version_2" })
          }
        ]
      };
      `,
      "utf-8"
    );

    // Reload plugin
    await runtime.loadPlugin(pluginDir);
    const res2 = await fakeServer._registeredTools["test_val"].handler({});
    assert.strictEqual(res2.val, "version_2");

    await runtime.unloadPlugin("wt-cache-test");
    fs.rmSync(pluginDir, { recursive: true, force: true });
  });
});
