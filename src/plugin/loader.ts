import { readdirSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, basename } from "node:path";
import type { WeavetabPlugin, WeavetabManifest, PluginContext } from "./interface.js";
import { PluginStorageManager } from "./storage.js";
import { PluginExtensionBridge } from "./extension_bridge.js";

const require = createRequire(import.meta.url);

export interface InstalledPluginInfo {
  packageName: string;
  dir: string;
  manifest: WeavetabManifest;
  pkgJson?: Record<string, any>;
  hasValidManifest: boolean;
}

function getNodeModulesDirs(customDir?: string): string[] {
  if (customDir) return [customDir];
  const dirs = [
    join(process.cwd(), "node_modules"),
    join(process.cwd(), "MCP", "node_modules"),
  ];
  return Array.from(new Set(dirs.filter((d) => existsSync(d))));
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
  const seenPackages = new Set<string>();

  const modulesDirs = getNodeModulesDirs(pluginDir);

  for (const modulesDir of modulesDirs) {
    try {
      const entries = readdirSync(modulesDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

        if (entry.name.startsWith("@")) {
          // Scoped packages (@weavetab/plugin-xyz, @scope/xyz)
          const scopeDir = join(modulesDir, entry.name);
          try {
            const scopeEntries = readdirSync(scopeDir, { withFileTypes: true });
            for (const scopeEntry of scopeEntries) {
              if (!scopeEntry.isDirectory() && !scopeEntry.isSymbolicLink()) continue;
              const info = inspectInstalledPackage(join(scopeDir, scopeEntry.name));
              if (info && !seenPackages.has(info.packageName)) {
                seenPackages.add(info.packageName);
                results.push(info);
              }
            }
          } catch { /* scope dir unreadable */ }
        } else {
          // Top-level packages (any name)
          const info = inspectInstalledPackage(join(modulesDir, entry.name));
          if (info && !seenPackages.has(info.packageName)) {
            seenPackages.add(info.packageName);
            results.push(info);
          }
        }
      }
    } catch { /* ignore filesystem errors */ }
  }

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
        Boolean(manifest.permissions?.tools) ||
        typeof plugin.onLoad === "function")
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

      // Initialize isolated storage sandbox in ~/.weavetab/plugins/<plugin-name>/
      const storageManager = new PluginStorageManager(plugin.name);
      const extensionBridge = new PluginExtensionBridge(plugin.name, manifest.permissions);
      const pluginConfig = storageManager.loadConfig(plugin.defaultConfig || manifest.defaultConfig || {});

      const hooks = {
        beforeToolCall: [] as Array<(toolName: string, args: Record<string, any>, session?: any) => Promise<any> | void>,
        afterToolCall: [] as Array<(toolName: string, args: Record<string, any>, result: any, session?: any) => Promise<any> | void>,
        onPageNavigate: [] as Array<(url: string, session?: any) => Promise<void> | void>,
      };

      plugin.storage = storageManager;
      plugin.extension = extensionBridge;
      plugin.hooks = hooks;

      // Construct rich PluginContext
      const pluginContext: PluginContext = {
        name: plugin.name,
        version: plugin.version,
        pluginDir: storageManager.getDirectory(),
        config: pluginConfig,
        storage: storageManager,
        extension: extensionBridge,
        mcp: {
          registerTool: (tool) => {
            plugin.tools = plugin.tools || [];
            const existingIndex = plugin.tools.findIndex((t: any) => t.name === tool.name);
            if (existingIndex >= 0) {
              plugin.tools[existingIndex] = tool;
            } else {
              plugin.tools.push(tool);
            }
          },
          overrideTool: (toolName, overrideHandler) => {
            plugin.overrides = plugin.overrides || [];
            plugin.overrides.push({ name: toolName, handler: overrideHandler });
          },
          removeTool: (toolName) => {
            plugin.removeTools = plugin.removeTools || [];
            plugin.removeTools.push(toolName);
          },
        },
        hooks: {
          beforeToolCall: (fn) => hooks.beforeToolCall.push(fn),
          afterToolCall: (fn) => hooks.afterToolCall.push(fn),
          onPageNavigate: (fn) => hooks.onPageNavigate.push(fn),
        },
        logger: {
          info: (...args: any[]) => console.error(`[Plugin: ${plugin.name}] [INFO]`, ...args),
          warn: (...args: any[]) => console.error(`[Plugin: ${plugin.name}] [WARN]`, ...args),
          error: (...args: any[]) => console.error(`[Plugin: ${plugin.name}] [ERROR]`, ...args),
          debug: (...args: any[]) => console.error(`[Plugin: ${plugin.name}] [DEBUG]`, ...args),
        },
      };

      // Execute dynamic onLoad if present
      if (typeof plugin.onLoad === "function") {
        try {
          const loadPromise = plugin.onLoad(pluginContext);
          if (loadPromise && typeof loadPromise.then === "function") {
            loadPromise.catch((err: any) => {
              console.error(`[Weavetab] Error in plugin "${plugin.name}" onLoad:`, err);
            });
          }
        } catch (e) {
          console.error(`[Weavetab] Synchronous error in plugin "${plugin.name}" onLoad:`, e);
        }
      }

      return plugin as WeavetabPlugin;
    }
  } catch (e: any) {
    // console.error(`Failed loading plugin at ${pkgDir}:`, e);
  }
  return null;
}

export function discoverPlugins(pluginDir?: string): WeavetabPlugin[] {
  const plugins: WeavetabPlugin[] = [];
  const seenPluginNames = new Set<string>();

  const modulesDirs = getNodeModulesDirs(pluginDir);

  for (const modulesDir of modulesDirs) {
    try {
      const entries = readdirSync(modulesDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

        if (entry.name.startsWith("@")) {
          // Scoped package directory (e.g. @weavetab, @microsoft, @mycompany)
          const scopeDir = join(modulesDir, entry.name);
          try {
            const scopeEntries = readdirSync(scopeDir, { withFileTypes: true });
            for (const scopeEntry of scopeEntries) {
              if (!scopeEntry.isDirectory() && !scopeEntry.isSymbolicLink()) continue;
              const plugin = tryLoadPlugin(join(scopeDir, scopeEntry.name));
              if (plugin && !seenPluginNames.has(plugin.name)) {
                seenPluginNames.add(plugin.name);
                plugins.push(plugin);
              }
            }
          } catch { /* scope dir unreadable */ }
        } else {
          // Top-level package — any name works: wt-github, my-cool-plugin, etc.
          const plugin = tryLoadPlugin(join(modulesDir, entry.name));
          if (plugin && !seenPluginNames.has(plugin.name)) {
            seenPluginNames.add(plugin.name);
            plugins.push(plugin);
          }
        }
      }
    } catch {
      // node_modules may not exist or be inaccessible
    }
  }

  return plugins;
}

/**
 * Loads a specific plugin by name from node_modules.
 */
export function loadPluginByName(name: string, pluginDir?: string): WeavetabPlugin | null {
  try {
    const modulesDirs = getNodeModulesDirs(pluginDir);

    for (const modulesDir of modulesDirs) {
      // Check if it's a top-level package
      let pkgDir = join(modulesDir, name);
      if (existsSync(pkgDir)) {
        const p = tryLoadPlugin(pkgDir);
        if (p) return p;
      }

      // Check if it's a scoped package (e.g. @weavetab/name)
      if (name.startsWith("@")) {
        const scopeParts = name.split("/");
        if (scopeParts.length === 2) {
          pkgDir = join(modulesDir, scopeParts[0], scopeParts[1]);
          if (existsSync(pkgDir)) {
            const p = tryLoadPlugin(pkgDir);
            if (p) return p;
          }
        }
      }
    }
  } catch {
    // Ignore
  }
  return null;
}
