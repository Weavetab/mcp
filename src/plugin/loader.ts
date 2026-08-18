import { readdirSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, basename } from "node:path";
import type { WeavetabPlugin, WeavetabManifest } from "./interface.js";

const require = createRequire(import.meta.url);

export interface InstalledPluginInfo {
  packageName: string;
  dir: string;
  manifest: WeavetabManifest;
  pkgJson?: Record<string, any>;
  hasValidManifest: boolean;
}

/**
 * Reads the manifest (weavetab.json) and package.json for an installed package
 * without executing its runtime code (safe for listing/inspection).
 */
export function inspectInstalledPackage(pkgDir: string): InstalledPluginInfo | null {
  const manifestPath = join(pkgDir, "weavetab.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const rawManifest = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(rawManifest) as WeavetabManifest;
    let pkgJson: Record<string, any> | undefined;

    const pkgPath = join(pkgDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        pkgJson = JSON.parse(readFileSync(pkgPath, "utf-8"));
      } catch { /* malformed package.json */ }
    }

    const packageName = pkgJson?.name || manifest.name || basename(pkgDir);
    return {
      packageName,
      dir: pkgDir,
      manifest,
      pkgJson,
      hasValidManifest: true,
    };
  } catch {
    return null;
  }
}

/**
 * Scan node_modules and return metadata for all installed Weavetab plugins.
 */
export function listInstalledPlugins(pluginDir?: string): InstalledPluginInfo[] {
  const results: InstalledPluginInfo[] = [];

  try {
    const modulesDir = pluginDir || join(process.cwd(), "node_modules");
    if (!existsSync(modulesDir)) return results;

    const entries = readdirSync(modulesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      if (entry.name.startsWith("@")) {
        // Scoped packages (@weavetab/plugin-xyz, @scope/xyz)
        const scopeDir = join(modulesDir, entry.name);
        try {
          const scopeEntries = readdirSync(scopeDir, { withFileTypes: true });
          for (const scopeEntry of scopeEntries) {
            if (!scopeEntry.isDirectory()) continue;
            const info = inspectInstalledPackage(join(scopeDir, scopeEntry.name));
            if (info) results.push(info);
          }
        } catch { /* scope dir unreadable */ }
      } else {
        // Top-level packages (any name)
        const info = inspectInstalledPackage(join(modulesDir, entry.name));
        if (info) results.push(info);
      }
    }
  } catch { /* ignore filesystem errors */ }

  return results;
}

/**
 * Attempt to load a single package as a Weavetab plugin for MCP server execution.
 * The presence of weavetab.json is the ONLY requirement — no name check needed.
 * This gives developers complete freedom to name their packages anything.
 */
function tryLoadPlugin(pkgDir: string): WeavetabPlugin | null {
  const manifestPath = join(pkgDir, "weavetab.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const rawManifest = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(rawManifest) as WeavetabManifest;

    let pkg: Record<string, any> = {};
    const pkgPath = join(pkgDir, "package.json");
    if (existsSync(pkgPath)) {
      pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    }

    const pluginMain = pkg.main || "index.js";
    const pluginModule = require(join(pkgDir, pluginMain));
    const plugin = pluginModule.default || pluginModule.plugin || pluginModule;

    if (
      plugin &&
      (Array.isArray(plugin.tools) ||
        Array.isArray(plugin.overrides) ||
        Array.isArray(plugin.removeTools) ||
        Boolean(manifest.permissions?.tools))
    ) {
      plugin.name = plugin.name || manifest.name || pkg.name || basename(pkgDir);
      plugin.version = plugin.version || manifest.version || pkg.version || "1.0.0";
      plugin.description = plugin.description || manifest.description || pkg.description || "";
      plugin.manifest = manifest;
      plugin.tools = Array.isArray(plugin.tools) ? plugin.tools : [];
      plugin.overrides = Array.isArray(plugin.overrides) ? plugin.overrides : [];
      plugin.removeTools = Array.isArray(plugin.removeTools)
        ? plugin.removeTools
        : manifest.permissions?.tools?.remove || [];
      return plugin as WeavetabPlugin;
    }
  } catch {
    // Not a valid plugin — skip silently
  }
  return null;
}

export function discoverPlugins(pluginDir?: string): WeavetabPlugin[] {
  const plugins: WeavetabPlugin[] = [];

  try {
    const modulesDir = pluginDir || join(process.cwd(), "node_modules");
    if (!existsSync(modulesDir)) return plugins;

    const entries = readdirSync(modulesDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      if (entry.name.startsWith("@")) {
        // Scoped package directory (e.g. @weavetab, @microsoft, @mycompany)
        const scopeDir = join(modulesDir, entry.name);
        try {
          const scopeEntries = readdirSync(scopeDir, { withFileTypes: true });
          for (const scopeEntry of scopeEntries) {
            if (!scopeEntry.isDirectory()) continue;
            const plugin = tryLoadPlugin(join(scopeDir, scopeEntry.name));
            if (plugin) plugins.push(plugin);
          }
        } catch { /* scope dir unreadable */ }
      } else {
        // Top-level package — any name works: wt-github, my-cool-plugin, etc.
        const plugin = tryLoadPlugin(join(modulesDir, entry.name));
        if (plugin) plugins.push(plugin);
      }
    }
  } catch {
    // node_modules may not exist or be inaccessible
  }

  return plugins;
}
