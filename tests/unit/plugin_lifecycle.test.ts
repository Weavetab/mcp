import { describe, it } from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  normalizePermissions,
  inspectInstalledPackage,
  buildPluginContext,
} from "../../src/plugin/loader.js";
import { hookPipeline } from "../../src/plugin/pipeline.js";
import { PluginStorageManager } from "../../src/plugin/storage.js";
import { PluginExtensionBridge } from "../../src/plugin/extension_bridge.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpPlugin(manifest: object, pkg?: object): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-plugin-test-"));
  fs.writeFileSync(path.join(tmpDir, "weavetab.json"), JSON.stringify(manifest, null, 2), "utf-8");
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify(pkg ?? { name: (manifest as any).name, version: (manifest as any).version }),
    "utf-8",
  );
  return tmpDir;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Report 5 Remediation — normalizePermissions (F5-07)", () => {
  it("normalizes flat string array format", () => {
    const normalized = normalizePermissions(["browser.evaluate", "browser.navigate", "fs.read", "extension.hud"]);
    assert.strictEqual(normalized.cdp?.evaluate, true);
    assert.strictEqual(normalized.cdp?.navigate, true);
    assert.deepStrictEqual(normalized.fs?.read, ["*"]);
    assert.strictEqual(normalized.extension?.hud, true);
  });

  it("treats 'filesystem' as an alias of 'fs'", () => {
    const normalized = normalizePermissions({
      filesystem: { read: ["/tmp"], write: ["/tmp"], reason: "File caching" },
    });
    assert.ok(normalized.fs !== undefined, "'fs' key must exist when 'filesystem' is used");
    assert.deepStrictEqual(normalized.fs?.read, ["/tmp"]);
    assert.strictEqual(normalized.fs?.reason, "File caching");
  });

  it("passes structured permissions through unchanged", () => {
    const normalized = normalizePermissions({
      cdp: { evaluate: true, reason: "Custom scripting" },
      network: { intercept: true, reason: "Request logging" },
      tools: { override: ["browser_eval"], remove: ["browser_inspect"], reason: "Security hardening" },
    });
    assert.strictEqual(normalized.cdp?.evaluate, true);
    assert.strictEqual(normalized.network?.intercept, true);
    assert.deepStrictEqual(normalized.tools?.override, ["browser_eval"]);
    assert.deepStrictEqual(normalized.tools?.remove, ["browser_inspect"]);
  });
});

describe("Report 5 Remediation — buildPluginContext (F5-02)", () => {
  it("provides a complete SDK-compliant PluginContext", () => {
    const pluginName = "test-context-plugin";
    const storageManager = new PluginStorageManager(pluginName);
    const extensionBridge = new PluginExtensionBridge(pluginName, {});
    const pluginConfig = { timeout: 3000, debug: false };
    const hooksList = { beforeToolCall: [] as any[], afterToolCall: [] as any[], onPageNavigate: [] as any[] };

    const plugin: any = { name: pluginName, version: "1.0.0", tools: [], overrides: [], removeTools: [] };
    const ctx = buildPluginContext(plugin, storageManager, extensionBridge, pluginConfig, hooksList);

    // Identity
    assert.strictEqual(ctx.name, pluginName);
    assert.strictEqual(ctx.version, "1.0.0");
    assert.ok(typeof ctx.pluginDir === "string");
    assert.deepStrictEqual(ctx.config, { timeout: 3000, debug: false });

    // Storage API
    assert.ok(typeof ctx.storage.get === "function");
    assert.ok(typeof ctx.storage.set === "function");
    assert.ok(typeof ctx.storage.delete === "function");

    // Extension API
    assert.ok(typeof ctx.extension.showThought === "function");
    assert.ok(typeof ctx.extension.setHudState === "function");

    // Hook registration API
    assert.ok(typeof ctx.hooks.beforeToolCall === "function");
    assert.ok(typeof ctx.hooks.afterToolCall === "function");
    assert.ok(typeof ctx.hooks.onPageNavigate === "function");

    // Logger API
    assert.ok(typeof ctx.logger.info === "function");
    assert.ok(typeof ctx.logger.warn === "function");
    assert.ok(typeof ctx.logger.error === "function");

    // Dynamic tool registration API
    assert.ok(typeof ctx.mcp.registerTool === "function");
    assert.ok(typeof ctx.mcp.overrideTool === "function");
    assert.ok(typeof ctx.mcp.removeTool === "function");
  });
});

describe("Report 5 Remediation — HookPipeline (F5-03)", () => {
  it("dispatches beforeToolCall, afterToolCall, and onPageNavigate hooks", async () => {
    hookPipeline.clearAllHooks();

    let beforeFired = false;
    let afterFired = false;
    let navigatedUrl = "";

    hookPipeline.registerPluginHooks("test-hook-plugin", {
      beforeToolCall: [async (_tool, args) => { beforeFired = true; return { ...args, injected: 1 }; }],
      afterToolCall: [async (_tool, _args, result) => { afterFired = true; return { ...result, modified: true }; }],
      onPageNavigate: [async (url) => { navigatedUrl = url; }],
    });

    const args = await hookPipeline.dispatchBeforeToolCall("some_tool", { x: 1 });
    assert.strictEqual(beforeFired, true);
    assert.strictEqual(args.injected, 1);

    const result = await hookPipeline.dispatchAfterToolCall("some_tool", args, { data: "ok" });
    assert.strictEqual(afterFired, true);
    assert.strictEqual(result.modified, true);
    assert.strictEqual(result.data, "ok");

    await hookPipeline.dispatchPageNavigate("https://example.com");
    assert.strictEqual(navigatedUrl, "https://example.com");

    hookPipeline.unregisterPluginHooks("test-hook-plugin");
    hookPipeline.clearAllHooks();
  });

  it("hook pipeline is resilient to a failing hook", async () => {
    hookPipeline.clearAllHooks();

    hookPipeline.registerPluginHooks("bad-plugin", {
      beforeToolCall: [async () => { throw new Error("hook crash"); }],
    });

    // Should not throw; should degrade gracefully and return original args
    const args = await hookPipeline.dispatchBeforeToolCall("some_tool", { safe: true });
    assert.strictEqual(args.safe, true);

    hookPipeline.unregisterPluginHooks("bad-plugin");
    hookPipeline.clearAllHooks();
  });
});

describe("Report 5 Remediation — Manifest Loading (F5-08, F5-11)", () => {
  it("inspects a plugin with flat string permissions", () => {
    const tmpDir = makeTmpPlugin({
      name: "my-plugin",
      version: "1.0.0",
      description: "A generic test plugin",
      permissions: ["browser.evaluate", "fs.read"],
    });
    try {
      const info = inspectInstalledPackage(tmpDir);
      assert.ok(info !== null);
      assert.strictEqual(info?.packageName, "my-plugin");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("inspects a plugin with structured tool override/remove permissions", () => {
    const tmpDir = makeTmpPlugin({
      name: "tool-override-plugin",
      version: "1.0.0",
      permissions: {
        tools: {
          override: ["browser_eval"],
          remove: ["browser_inspect"],
          reason: "Upgraded sandboxed executor",
        },
      },
    });
    try {
      const info = inspectInstalledPackage(tmpDir);
      assert.ok(info !== null);
      assert.deepStrictEqual(info?.manifest.permissions?.tools?.override, ["browser_eval"]);
      assert.deepStrictEqual(info?.manifest.permissions?.tools?.remove, ["browser_inspect"]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("respects manifest.entry over package.main", () => {
    const tmpDir = makeTmpPlugin(
      { name: "entry-test-plugin", version: "1.0.0", entry: "dist/plugin.js" },
      { name: "entry-test-plugin", version: "1.0.0", main: "index.js" },
    );
    try {
      const info = inspectInstalledPackage(tmpDir);
      assert.strictEqual(info?.manifest.entry, "dist/plugin.js");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
