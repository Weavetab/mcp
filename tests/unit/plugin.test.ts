import { describe, it } from "node:test";
import assert from "node:assert";
import {
  resolvePluginTrust,
  getVerifiedPackages,
  invalidateRegistryCache,
} from "../../src/plugin/registry.js";
import { inspectInstalledPackage } from "../../src/plugin/loader.js";
import { PluginStorageManager } from "../../src/plugin/storage.js";
import { PluginExtensionBridge } from "../../src/plugin/extension_bridge.js";
import { toPluginInputShape } from "../../src/plugin/schema.js";
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
    JSON.stringify(pkg ?? { name: (manifest as any).name, version: (manifest as any).version }),
    "utf-8",
  );
  return tmpDir;
}

// ─── Trust Tier Tests (self-contained, no registry I/O) ───────────────────────

describe("Plugin Trust Tier Resolution", () => {
  // A stand-alone set — no real package names, just structural tests
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
  it("inspects a plugin directory with a weavetab.json", () => {
    const tmpDir = makeTmpPlugin({
      name: "test-plugin",
      version: "1.0.0",
      description: "Generic test plugin",
      tools: [{ name: "do_something", description: "Does something" }],
      permissions: { network: { intercept: true, reason: "Needs network" } },
    });
    try {
      const info = inspectInstalledPackage(tmpDir);
      assert.ok(info !== null);
      assert.strictEqual(info?.packageName, "test-plugin");
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
      version: "1.0.0",
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
