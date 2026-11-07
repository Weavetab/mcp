import { describe, it, after } from "node:test";
import assert from "node:assert";
import {
  resolvePluginTrust,
  getVerifiedPackages,
  invalidateRegistryCache,
} from "../../src/plugin/registry.js";
import {
  inspectInstalledPackage,
  buildPluginContext,
  normalizePermissions,
  clampPluginInstructions,
  getPluginCommands,
  buildPluginInstructions,
  touchPluginEpoch,
  MAX_INSTRUCTIONS_LINES,
  MAX_INSTRUCTIONS_CHARS,
} from "../../src/plugin/loader.js";
import { compareSemver } from "../../src/cli/plugin.js";
import { PluginStorageManager } from "../../src/plugin/storage.js";
import { PluginExtensionBridge } from "../../src/plugin/extension_bridge.js";
import { toPluginInputShape, toPromptShape } from "../../src/plugin/schema.js";
import { createSurface } from "../../src/plugin/surface.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpPlugin(manifest: object, pkg?: object): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wt-test-"));
  fs.writeFileSync(path.join(tmpDir, "weavetab.json"), JSON.stringify(manifest), "utf-8");
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify(pkg ?? { name: (manifest as any).name || "test-plugin", version: (manifest as any).version || "1.0.0" }),
    "utf-8",
  );
  return tmpDir;
}

// ─── Trust Tier Tests (self-contained, no registry I/O) ───────────────────────

describe("Plugin Trust Tier Resolution", () => {
  const mockVerified = new Set(["plugin-a", "plugin-b", "plugin-c"]);

  it("classifies @weavetab/plugin-* as official tier", () => {
    const t = resolvePluginTrust("@weavetab/plugin-foo", mockVerified);
    assert.strictEqual(t.tier, "official");
    assert.strictEqual(t.label, "Official");
  });

  it("classifies packages present in the verified set as verified tier", () => {
    const t = resolvePluginTrust("plugin-a", mockVerified);
    assert.strictEqual(t.tier, "verified");
    assert.strictEqual(t.label, "Verified");
  });

  it("classifies unknown packages as unverified tier", () => {
    const t = resolvePluginTrust("some-random-package", mockVerified);
    assert.strictEqual(t.tier, "unverified");
    assert.strictEqual(t.label, "Unverified");
    assert.match(t.tooltip, /not been verified/i);
  });

  it("loads verified.json registry and returns a Set", async () => {
    invalidateRegistryCache();
    const packages = await getVerifiedPackages();
    assert.ok(packages instanceof Set, "getVerifiedPackages must return a Set");
  });

  it("resolves an explicit scoped @weavetab/plugin-* package directly", async () => {
    const { resolvePluginCandidates } = await import("../../src/plugin/registry.js");
    const candidates = await resolvePluginCandidates("@weavetab/plugin-foo", mockVerified);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].packageName, "@weavetab/plugin-foo");
    assert.strictEqual(candidates[0].tier, "official");
  });

  it("resolves a short name into an official shortcut and a community candidate", async () => {
    const { resolvePluginCandidates } = await import("../../src/plugin/registry.js");
    const candidates = await resolvePluginCandidates("my-tool", mockVerified);
    assert.ok(candidates.length >= 1);
    const hasOfficial = candidates.some((c) => c.packageName === "@weavetab/plugin-my-tool" && c.isOfficialShortcut);
    const hasCommunity = candidates.some((c) => c.packageName === "my-tool" && !c.isOfficialShortcut);
    assert.ok(hasOfficial || hasCommunity);
  });
});

// ─── Manifest Inspection ──────────────────────────────────────────────────────

describe("Plugin Manifest Inspection", () => {
  it("inspects a plugin directory with a weavetab.json and package.json", () => {
    const tmpDir = makeTmpPlugin(
      {
        name: "test-plugin",
        description: "Generic test plugin",
        tools: [{ name: "do_something", description: "Does something" }],
        permissions: { network: { intercept: true, reason: "Needs network" } },
      },
      {
        name: "test-plugin",
        version: "1.4.2",
        license: "MIT",
        author: "Test Author",
      }
    );
    try {
      const info = inspectInstalledPackage(tmpDir);
      assert.ok(info !== null);
      assert.strictEqual(info?.packageName, "test-plugin");
      assert.strictEqual(info?.pkgJson?.version, "1.4.2");
      assert.strictEqual(info?.manifest.tools?.length, 1);
      assert.strictEqual(info?.manifest.tools?.[0].name, "do_something");
      assert.strictEqual(info?.manifest.permissions?.network?.intercept, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("parses tool override and remove permissions", () => {
    const tmpDir = makeTmpPlugin({
      name: "test-override-plugin",
      permissions: {
        tools: {
          override: ["browser_eval"],
          remove: ["browser_inspect"],
          reason: "Sandboxed execution",
        },
      },
    });
    try {
      const info = inspectInstalledPackage(tmpDir);
      assert.ok(info !== null);
      assert.deepStrictEqual(info?.manifest.permissions?.tools?.override, ["browser_eval"]);
      assert.deepStrictEqual(info?.manifest.permissions?.tools?.remove, ["browser_inspect"]);
      assert.strictEqual(info?.manifest.permissions?.tools?.reason, "Sandboxed execution");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("simulates an override handler wrapping the original tool", async () => {
    const originalHandler = async (args: Record<string, any>) => ({ output: `result: ${args.value}` });

    const overrideHandler = async (args: any, _s: any, _c: any, orig?: any) => {
      const base = orig ? await orig({ value: args.value }) : null;
      return { wrapped: true, base };
    };

    const res = await overrideHandler({ value: "test" }, {}, {}, originalHandler);
    assert.strictEqual(res.wrapped, true);
    assert.deepStrictEqual(res.base, { output: "result: test" });
  });
});

// ─── Plugin Storage Sandbox ───────────────────────────────────────────────────

describe("Plugin Isolated Storage", () => {
  const storage = new PluginStorageManager("unit-test-storage-" + Date.now());

  after(() => {
    try {
      fs.rmSync(storage.getDirectory(), { recursive: true, force: true });
    } catch {}
  });

  it("creates an isolated directory and loads default config", () => {
    const dir = storage.getDirectory();
    assert.ok(fs.existsSync(dir));
    assert.ok(dir.includes("plugins"));

    const cfg = storage.loadConfig({ enabled: true, timeout: 5000 });
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.timeout, 5000);
    assert.ok(fs.existsSync(storage.getConfigPath()));
  });

  it("reads and writes key-value store", async () => {
    await storage.set("key1", "value1");
    await storage.set("count", 7);

    assert.strictEqual(await storage.get<string>("key1"), "value1");
    assert.strictEqual(await storage.get<number>("count"), 7);

    assert.strictEqual(await storage.delete("key1"), true);
    assert.strictEqual(await storage.get("key1"), null);
  });

  it("reads and writes JSON files inside the plugin directory", async () => {
    const data = { items: ["x", "y"], total: 2 };
    await storage.setJSON("data/result.json", data);
    assert.deepStrictEqual(await storage.getJSON("data/result.json"), data);
  });

  it("rejects path traversal attempts", () => {
    assert.throws(() => storage.getPath("../../outside.txt"), /Security Violation/i);
  });

  it("handles setWithExpiry, getWithExpiry, and remember cache-aside", async () => {
    let computed = 0;
    const fetchValue = async () => {
      computed++;
      return "expensive_result";
    };
    const res1 = await storage.remember("cache_test", 50, fetchValue);
    assert.strictEqual(res1, "expensive_result");
    assert.strictEqual(computed, 1);
    const res2 = await storage.remember("cache_test", 50, fetchValue);
    assert.strictEqual(res2, "expensive_result");
    assert.strictEqual(computed, 1);
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual(await storage.getWithExpiry("cache_test"), null);
    const res3 = await storage.remember("cache_test", 50, fetchValue);
    assert.strictEqual(res3, "expensive_result");
    assert.strictEqual(computed, 2);
    await storage.setWithExpiry("stale1", "val", 1);
    await new Promise((r) => setTimeout(r, 10));
    const pruned = await storage.pruneExpired();
    assert.ok(pruned >= 1);
  });
});

// ─── Extension Bridge ─────────────────────────────────────────────────────────

describe("Plugin Extension Bridge", () => {
  it("enforces permission boundaries (styles denied when not granted)", async () => {
    const bridge = new PluginExtensionBridge("unit-test-ext-plugin", {
      extension: { hud: true, styles: false },
    });

    await assert.rejects(
      async () => bridge.injectStyles({} as any, "body { color: red; }"),
      /Permission Denied/i,
    );
  });
});

// ─── Tool Schema Normalizer ───────────────────────────────────────────────────

describe("toPluginInputShape", () => {
  it("passes a Zod raw shape through unchanged", () => {
    const shape = { name: z.string(), count: z.number() };
    const result = toPluginInputShape(shape);
    assert.strictEqual(result, shape);
  });

  it("extracts the shape from a Zod object schema", () => {
    const result = toPluginInputShape(z.object({ name: z.string() }));
    assert.ok(result.name);
    assert.strictEqual(typeof (result.name as any).parse, "function");
    assert.strictEqual(Object.keys(result).length, 1);
  });

  it("converts a plain JSON Schema object into a Zod raw shape", () => {
    const result = toPluginInputShape({
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector" },
        limit: { type: "number" },
        dryRun: { type: "boolean" },
      },
      required: ["selector"],
    });
    assert.strictEqual(Object.keys(result).length, 3);
    assert.strictEqual(result.selector.safeParse("a").success, true);
    assert.strictEqual(result.limit.safeParse(5).success, true);
    assert.strictEqual(result.dryRun.safeParse(true).success, true);
    assert.strictEqual(result.selector.description, "CSS selector");
  });

  it("returns an empty shape for null/empty/unknown input", () => {
    assert.deepStrictEqual(toPluginInputShape(undefined), {});
    assert.deepStrictEqual(toPluginInputShape({}), {});
    assert.deepStrictEqual(toPluginInputShape({ foo: "bar" }), {});
  });
});

// ─── Plugin Prompts (/) and Resources (@) Surface ─────────────────────────────

describe("Plugin Prompts and Resources Surface", () => {
  it("enforces permissions.prompts.add and permissions.resources.add in buildPluginContext", () => {
    const storage = new PluginStorageManager("unit-test-surface-perms");
    const bridge = new PluginExtensionBridge("unit-test-surface-perms", {});
    const hooks = { beforeToolCall: [], afterToolCall: [], onPageNavigate: [] };

    const lockedPlugin: any = { name: "locked", version: "1.0.0", manifest: { permissions: {} } };
    const lockedCtx = buildPluginContext(lockedPlugin, storage, bridge, {}, hooks);
    lockedCtx.mcp.registerPrompt({ name: "cmd", handler: () => "hi" });
    lockedCtx.mcp.registerResource({ name: "res", uri: "custom://a", read: () => "x" });
    assert.strictEqual(lockedPlugin.prompts, undefined);
    assert.strictEqual(lockedPlugin.resources, undefined);

    const openPerms = normalizePermissions(["prompts.add", "resources.add"]);
    const openPlugin: any = { name: "open", version: "1.0.0", manifest: { permissions: openPerms } };
    const openCtx = buildPluginContext(openPlugin, storage, bridge, {}, hooks);
    openCtx.mcp.registerPrompt({ name: "cmd", handler: () => "hi" });
    openCtx.mcp.registerResource({ name: "res", uri: "custom://a", read: () => "x" });
    assert.strictEqual(openPlugin.prompts.length, 1);
    assert.strictEqual(openPlugin.resources.length, 1);
  });

  it("registers prompts, fixed resources, and URI template resources with autocomplete, and removes them cleanly", async () => {
    const mcp = new McpServer({ name: "test", version: "1.0.0" });
    const warnings: string[] = [];
    const storage = new PluginStorageManager("unit-test-surface");
    const surface = createSurface(
      mcp,
      () => ({ storage, config: { env: "test" }, logger: { info() {}, warn() {}, error() {}, debug() {} } }),
      (w) => warnings.push(w)
    );

    const okPrompt = surface.addPrompt("plug-a", {
      name: "quick_scan",
      description: "Run a quick scan",
      arguments: toPromptShape({ type: "object", properties: { target: { type: "string" } }, required: ["target"] }),
      handler: async (args) => `Scanning ${args.target}`,
    });
    assert.strictEqual(okPrompt, true);
    assert.strictEqual(surface.addPrompt("plug-b", { name: "quick_scan", handler: () => "dup" }), false);
    assert.strictEqual(surface.addPrompt("plug-a", { name: "BAD NAME!", handler: () => "x" }), false);

    const okFixed = surface.addResource("plug-a", {
      name: "realtime-state",
      uri: "realtime://state",
      mimeType: "application/json",
      read: async () => JSON.stringify({ active: true }),
    });
    assert.strictEqual(okFixed, true);
    assert.strictEqual(
      surface.addResource("plug-a", { name: "stolen", uri: "weavetab://active-tab", read: () => "no" }),
      false
    );

    const okTpl = surface.addResource("plug-a", {
      name: "reflex-by-id",
      uriTemplate: "realtime://reflex/{id}",
      list: async () => [{ uri: "realtime://reflex/r1", name: "r1" }],
      complete: { id: async (prefix) => ["r1", "r2"].filter((x) => x.startsWith(prefix)) },
      read: async (uri, vars) => ({ text: `reflex=${vars.id}@${uri}` }),
    });
    assert.strictEqual(okTpl, true);
    assert.deepStrictEqual(surface.count(), { prompts: 1, resources: 2 });

    const promptEntry = (mcp as any)._registeredPrompts["quick_scan"];
    const promptOut = await promptEntry.callback({ target: "login" });
    assert.strictEqual(promptOut.messages[0].content.text, "Scanning login");

    const resEntry = (mcp as any)._registeredResources["realtime://state"];
    const resOut = await resEntry.readCallback(new URL("realtime://state"));
    assert.strictEqual(resOut.contents[0].text, JSON.stringify({ active: true }));

    const tplEntry = (mcp as any)._registeredResourceTemplates["reflex-by-id"];
    const completeFn = tplEntry.resourceTemplate.completeCallback("id");
    assert.deepStrictEqual(await completeFn("r"), ["r1", "r2"]);
    const tplOut = await tplEntry.readCallback(new URL("realtime://reflex/r1"), { id: "r1" });
    assert.strictEqual(tplOut.contents[0].text, "reflex=r1@realtime://reflex/r1");

    assert.strictEqual(surface.dropAll("plug-a"), true);
    assert.deepStrictEqual(surface.count(), { prompts: 0, resources: 0 });
    assert.ok(warnings.length >= 3);
  });
});

// ─── Plugin CLI Commands & Instructions Context Budgeting ─────────────────────

describe("Plugin CLI Commands and Instructions Context Budgeting", () => {
  it("enforces permissions.commands.add when registering CLI commands via buildPluginContext", () => {
    const storage = new PluginStorageManager("unit-test-cmd-perms");
    const bridge = new PluginExtensionBridge("unit-test-cmd-perms", {});
    const hooks = { beforeToolCall: [], afterToolCall: [], onPageNavigate: [] };

    // 1. Blocked when permissions.commands.add is missing
    const lockedPlugin: any = { name: "locked-cmd", version: "1.0.0", manifest: { permissions: {} } };
    const lockedCtx = buildPluginContext(lockedPlugin, storage, bridge, {}, hooks);
    lockedCtx.cli.registerCommand({ name: "dump", handler: async () => "ok" });
    assert.strictEqual(lockedPlugin.commands, undefined);

    // 2. Allowed when permissions.commands.add is granted
    const openPerms = normalizePermissions(["commands.add"]);
    const openPlugin: any = { name: "open-cmd", version: "1.0.0", manifest: { permissions: openPerms } };
    const openCtx = buildPluginContext(openPlugin, storage, bridge, {}, hooks);
    openCtx.cli.registerCommand({ name: "dump", description: "Dumps state", handler: async () => "dumped" });
    assert.ok(Array.isArray(openPlugin.commands));
    assert.strictEqual(openPlugin.commands.length, 1);
    assert.strictEqual(openPlugin.commands[0].name, "dump");

    // 3. Unregister removes command
    openCtx.cli.unregisterCommand("dump");
    assert.strictEqual(openPlugin.commands.length, 0);
  });

  it("clamps instructions to strict line (80) and char (3200) budget", () => {
    const normalContent = "Use test_tool for inspections.\nRun weavetab plugin use test dump for CLI.";
    assert.strictEqual(clampPluginInstructions(normalContent), normalContent);

    const linesArray = Array.from({ length: 120 }, (_, i) => `Line ${i + 1}: instruction`);
    const readClampedLines = clampPluginInstructions(linesArray.join("\n"));
    assert.ok(readClampedLines);
    const outputLines = readClampedLines.split("\n");
    assert.strictEqual(outputLines.length, MAX_INSTRUCTIONS_LINES);
    assert.strictEqual(outputLines[0], "Line 1: instruction");
    assert.strictEqual(outputLines[79], "Line 80: instruction");

    const bigLine = "A".repeat(100);
    const bigContent = Array.from({ length: 50 }, () => bigLine).join("\n");
    const readClampedChars = clampPluginInstructions(bigContent);
    assert.ok(readClampedChars);
    assert.strictEqual(readClampedChars.length, MAX_INSTRUCTIONS_CHARS);
  });

  it("inspects inline instructions in inspectInstalledPackage", () => {
    const tmpDir = makeTmpPlugin({
      name: "pkg-inline-instructions",
      description: "Plugin with declared instructions",
      instructions: "Always prefer CLI commands over UI clicks.",
    });
    try {
      const info = inspectInstalledPackage(tmpDir);
      assert.ok(info !== null);
      assert.strictEqual(info?.packageName, "pkg-inline-instructions");
      assert.strictEqual(info?.instructions, "Always prefer CLI commands over UI clicks.");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("getPluginCommands and buildPluginInstructions group CLI commands and instructions per plugin", () => {
    const fakePlugin: any = {
      name: "test-plugin",
      version: "1.2.0",
      instructions: "Follow strict formatting guidelines.",
      manifest: {
        commands: [
          { name: "scan", description: "Performs quick scan", usage: "weavetab plugin use test-plugin scan" },
        ],
      },
      commands: [
        { name: "audit", description: "Runs audit" },
      ],
    };

    const cmds = getPluginCommands(fakePlugin);
    assert.strictEqual(cmds.length, 2);
    assert.strictEqual(cmds[0].name, "scan");
    assert.strictEqual(cmds[1].name, "audit");
    assert.strictEqual(cmds[1].usage, "weavetab plugin use test-plugin audit");

    const instructionsText = buildPluginInstructions([fakePlugin]);
    assert.ok(instructionsText.includes("## Active Weavetab Plugins"));
    assert.ok(instructionsText.includes("### test-plugin (v1.2.0)"));
    assert.ok(instructionsText.includes("Follow strict formatting guidelines."));
    assert.ok(instructionsText.includes("weavetab plugin use test-plugin scan"));
    assert.ok(instructionsText.includes("weavetab plugin use test-plugin audit"));
  });

  it("compareSemver orders versions accurately for weavetab plugin update", () => {
    assert.ok(compareSemver("1.4.0", "1.3.0") > 0);
    assert.ok(compareSemver("2.0.0", "1.9.9") > 0);
    assert.strictEqual(compareSemver("1.3.0", "1.3.0"), 0);
    assert.ok(compareSemver("1.2.9", "1.3.0") < 0);
  });

  it("touchPluginEpoch touches .epoch file in global directory", () => {
    touchPluginEpoch();
    const epochPath = path.join(os.homedir(), ".weavetab", "plugins", ".epoch");
    assert.ok(fs.existsSync(epochPath));
    const content = fs.readFileSync(epochPath, "utf-8");
    assert.ok(Number(content) > 0);
  });
});
