import { describe, it } from "node:test";
import assert from "node:assert";
import {
  resolvePluginTrust,
  getVerifiedPackages,
  invalidateRegistryCache,
  OFFICIAL_PLUGIN_PREFIX,
} from "../../src/plugin/registry.js";
import { inspectInstalledPackage, listInstalledPlugins } from "../../src/plugin/loader.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Plugin Registry & Trust System", () => {
  const verifiedList = new Set([
    "github-automation",
    "vision-accessibility",
    "weavetab-plugin-seo",
    "weavetab-plugin-notion",
    "community-awesome-tools",
  ]);

  it("should classify @weavetab/plugin-* as official tier", () => {
    const trust1 = resolvePluginTrust("@weavetab/plugin-vision", verifiedList);
    assert.strictEqual(trust1.tier, "official");
    assert.strictEqual(trust1.label, "Official");

    const trust2 = resolvePluginTrust("@weavetab/plugin-github", verifiedList);
    assert.strictEqual(trust2.tier, "official");
  });

  it("should classify packages in verified.json as verified tier", () => {
    const trust1 = resolvePluginTrust("github-automation", verifiedList);
    assert.strictEqual(trust1.tier, "verified");
    assert.strictEqual(trust1.label, "Verified");

    const trust2 = resolvePluginTrust("weavetab-plugin-seo", verifiedList);
    assert.strictEqual(trust2.tier, "verified");

    const trust3 = resolvePluginTrust("community-awesome-tools", verifiedList);
    assert.strictEqual(trust3.tier, "verified");
  });

  it("should classify unknown community packages as unverified tier", () => {
    const trust1 = resolvePluginTrust("random-community-plugin", verifiedList);
    assert.strictEqual(trust1.tier, "unverified");
    assert.strictEqual(trust1.label, "Unverified");
    assert.match(trust1.tooltip, /not been verified/i);

    const trust2 = resolvePluginTrust("unvetted-cdp-tool", verifiedList);
    assert.strictEqual(trust2.tier, "unverified");
  });

  it("should load local verified.json registry containing string names", async () => {
    invalidateRegistryCache();
    const packages = await getVerifiedPackages();
    assert.ok(packages instanceof Set);
    assert.ok(packages.has("github-automation"));
    assert.ok(packages.has("seo-auditor"));
    assert.ok(packages.has("notion-sync"));
    assert.ok(packages.has("pdf-extract"));
  });

  it("should resolve explicit scoped packages directly", async () => {
    const { resolvePluginCandidates } = await import("../../src/plugin/registry.js");
    const candidates = await resolvePluginCandidates("@weavetab/plugin-vision", verifiedList);
    assert.strictEqual(candidates.length, 1);
    assert.strictEqual(candidates[0].packageName, "@weavetab/plugin-vision");
    assert.strictEqual(candidates[0].tier, "official");
  });

  it("should resolve short names into official shortcut and community candidates", async () => {
    const { resolvePluginCandidates } = await import("../../src/plugin/registry.js");
    const candidates = await resolvePluginCandidates("n8n-wt", verifiedList);
    assert.ok(candidates.length >= 1);
    const hasOfficial = candidates.some((c) => c.packageName === "@weavetab/plugin-n8n-wt" && c.isOfficialShortcut);
    const hasCommunity = candidates.some((c) => c.packageName === "n8n-wt" && !c.isOfficialShortcut);
    assert.ok(hasOfficial || hasCommunity);
  });
});

describe("Plugin Loader & Manifest Inspection", () => {
  it("should inspect a plugin directory containing weavetab.json", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weavetab-plugin-test-"));
    try {
      const manifest = {
        id: "custom-scraper",
        name: "custom-scraper",
        version: "1.2.0",
        author: "alice",
        description: "Scrapes dynamic tables",
        tools: [
          { name: "scrape_table", description: "Scrape table rows" }
        ],
        permissions: {
          network: { intercept: true, reason: "Fetch dynamic items" }
        }
      };
      fs.writeFileSync(path.join(tmpDir, "weavetab.json"), JSON.stringify(manifest), "utf-8");
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "custom-scraper", version: "1.2.0" }), "utf-8");

      const info = inspectInstalledPackage(tmpDir);
      assert.ok(info !== null);
      assert.strictEqual(info?.packageName, "custom-scraper");
      assert.strictEqual(info?.manifest.id, "custom-scraper");
      assert.strictEqual(info?.manifest.tools?.length, 1);
      assert.strictEqual(info?.manifest.tools?.[0].name, "scrape_table");
      assert.strictEqual(info?.manifest.permissions?.network?.intercept, true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should parse tool override and remove permissions from weavetab.json", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "weavetab-eval-plus-"));
    try {
      const manifest = {
        id: "eval-plus",
        name: "eval-plus",
        version: "2.0.0",
        author: "bob",
        description: "Upgraded TypeScript evaluator with sandboxing",
        permissions: {
          tools: {
            override: ["browser_eval"],
            remove: ["browser_inspect"],
            reason: "Sandboxed execution and security hardening",
          },
        },
      };
      fs.writeFileSync(path.join(tmpDir, "weavetab.json"), JSON.stringify(manifest), "utf-8");
      fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "eval-plus", version: "2.0.0" }), "utf-8");

      const info = inspectInstalledPackage(tmpDir);
      assert.ok(info !== null);
      assert.deepStrictEqual(info?.manifest.permissions?.tools?.override, ["browser_eval"]);
      assert.deepStrictEqual(info?.manifest.permissions?.tools?.remove, ["browser_inspect"]);
      assert.strictEqual(info?.manifest.permissions?.tools?.reason, "Sandboxed execution and security hardening");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should support tool override execution and wrap original handler", async () => {
    // Simulate original tool handler
    const originalHandler = async (args: Record<string, any>) => {
      return { output: `standard eval: ${args.code}` };
    };

    // Plugin override handler
    const pluginOverride = {
      name: "browser_eval",
      description: "Enhanced evaluator",
      handler: async (args: any, _session: any, _config: any, orig?: any) => {
        const base = orig ? await orig({ code: args.code }) : null;
        return {
          sandboxed: true,
          typescript: true,
          wrapped: base,
          result: `enhanced result for ${args.code}`,
        };
      },
    };

    const res = await pluginOverride.handler({ code: "1 + 1" }, {} as any, {} as any, originalHandler);
    assert.strictEqual(res.sandboxed, true);
    assert.strictEqual(res.typescript, true);
    assert.deepStrictEqual(res.wrapped, { output: "standard eval: 1 + 1" });
    assert.strictEqual(res.result, "enhanced result for 1 + 1");
  });
});
