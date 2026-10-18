import { readdirSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, basename } from "node:path";
import os from "node:os";
import type { WeavetabPlugin, WeavetabManifest, WeavetabPermissions, PluginContext } from "./interface.js";
import { PluginStorageManager } from "./storage.js";
import { PluginExtensionBridge } from "./extension_bridge.js";
import { getSiteProfile, learnPattern, recordPatternExecution, getPatternReliability, recordQuirk } from "../intelligence/patternCompiler.js";

const require = createRequire(import.meta.url);

export interface InstalledPluginInfo {
  packageName: string;
  dir: string;
  manifest: WeavetabManifest;
  pkgJson?: Record<string, any>;
  hasValidManifest: boolean;
}
import { WEAVETAB_VERSION } from "../version.js";

const RUNTIME_VERSION = WEAVETAB_VERSION;

function getNodeModulesDirs(customDir?: string): string[] {
  if (customDir) return [customDir];
  const cwd = process.cwd();
  const dirs = [
    join(cwd, "node_modules"),
    join(cwd, "MCP", "node_modules"),
    join(cwd, "..", "node_modules"),
    join(os.homedir(), ".weavetab", "plugins", "node_modules"),
  ];
  return Array.from(new Set(dirs.filter((d) => existsSync(d))));
}

/**
 * Normalizes permissions format across legacy arrays and object aliases (filesystem vs fs).
 */
export function normalizePermissions(perms?: any): WeavetabPermissions {
  if (!perms) return {};

  // Handle flat string array: ["browser.evaluate", "tools.add", "tools", "fs.read", ...]
  if (Array.isArray(perms)) {
    const normalized: WeavetabPermissions = { cdp: {}, fs: {}, filesystem: {}, extension: {}, tools: {}, hooks: {} };
    for (const item of perms) {
      if (typeof item !== "string") continue;
      const [cat, sub] = item.split(".");
      if (cat === "browser" || cat === "cdp") {
        (normalized.cdp as any)[sub || "evaluate"] = true;
      } else if (cat === "fs" || cat === "filesystem") {
        (normalized.fs as any)[sub || "read"] = ["*"];
        (normalized.filesystem as any)[sub || "read"] = ["*"];
      } else if (cat === "extension" || cat === "hud") {
        (normalized.extension as any)[sub || "hud"] = true;
      } else if (cat === "tools") {
        normalized.tools = normalized.tools || {};
        if (!sub || sub === "add") {
          normalized.tools.add = true;
        }
      } else if (cat === "hooks") {
        normalized.hooks = normalized.hooks || {};
        if (sub) {
          (normalized.hooks as any)[sub] = true;
        } else {
          normalized.hooks.onBeforeAction = true;
          normalized.hooks.onAfterAction = true;
        }
      }
    }
    return normalized;
  }

  const result: WeavetabPermissions = { ...perms };

  // Reconcile filesystem <-> fs alias
  if (perms.filesystem && !perms.fs) {
    result.fs = perms.filesystem;
  } else if (perms.fs && !perms.filesystem) {
    result.filesystem = perms.fs;
  }

  return result;
}

/**
 * Validates whether the plugin's engine requirement matches the current runtime version.
 */
function checkEngineCompatibility(engineReq?: string): { compatible: boolean; message?: string } {
  if (!engineReq || engineReq === "*" || engineReq === "latest") {
    return { compatible: true };
  }

  // Simple semver range parsing (handles ^x.y.z, >=x.y.z, ~x.y.z, x.y.z)
  const cleanReq = engineReq.replace(/[\^~>=]/g, "").trim();
  const reqParts = cleanReq.split(".").map((p) => parseInt(p, 10));
  const curParts = RUNTIME_VERSION.split("-")[0].split(".").map((p) => parseInt(p, 10));

  if (engineReq.startsWith("^")) {
    // Caret: same major
    if (curParts[0] === reqParts[0] && (curParts[1] > reqParts[1] || (curParts[1] === reqParts[1] && curParts[2] >= reqParts[2]))) {
      return { compatible: true };
    }
  } else if (engineReq.startsWith(">=")) {
    if (curParts[0] > reqParts[0] || (curParts[0] === reqParts[0] && curParts[1] >= reqParts[1])) {
      return { compatible: true };
    }
  } else {
    // Exact or direct match
    if (curParts[0] === reqParts[0] && curParts[1] === reqParts[1]) {
      return { compatible: true };
    }
  }

  return {
    compatible: false,
    message: `Plugin requires Weavetab version ${engineReq}, but current runtime is ${RUNTIME_VERSION}.`,
  };
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
          // Scoped packages (@weavetab/plugin-xyz, @scope/xyz, @acme/weavetab-plugin)
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
          // Top-level packages (any name: wt-github, custom-plugin, etc.)
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

export function buildPluginContext(
  plugin: WeavetabPlugin,
  storageManager: PluginStorageManager,
  extensionBridge: PluginExtensionBridge,
  pluginConfig: Record<string, any>,
  hooks: {
    beforeToolCall: Array<(toolName: string, args: Record<string, any>, session?: any) => Promise<any> | void>;
    afterToolCall: Array<(toolName: string, args: Record<string, any>, result: any, session?: any) => Promise<any> | void>;
    onPageNavigate: Array<(url: string, session?: any) => Promise<void> | void>;
  }
): PluginContext {
  const perms = (plugin.manifest?.permissions as WeavetabPermissions) ?? {};
  const pname = plugin.name;

  return {
    name: pname,
    version: plugin.version,
    pluginDir: storageManager.getDirectory(),
    config: pluginConfig,
    storage: storageManager,
    extension: extensionBridge,
    mcp: {
      registerTool: (tool: any) => {
        if (!perms.tools?.add) {
          console.error(`[Plugin: ${pname}] blocked registerTool("${tool?.name}"): permissions.tools.add not declared`);
          return;
        }
        plugin.tools = plugin.tools || [];
        const idx = plugin.tools.findIndex((t: any) => t.name === tool.name);
        if (idx >= 0) {
          plugin.tools[idx] = tool;
        } else {
          plugin.tools.push(tool);
        }
      },
      overrideTool: (toolName: string, overrideHandler: any) => {
        const allowed = perms.tools?.override ?? [];
        if (!allowed.includes(toolName)) {
          console.error(`[Plugin: ${pname}] blocked overrideTool("${toolName}"): not listed in permissions.tools.override`);
          return;
        }
        plugin.overrides = plugin.overrides || [];
        plugin.overrides.push({ name: toolName, handler: overrideHandler });
      },
      removeTool: (toolName: string) => {
        const allowed = perms.tools?.remove ?? [];
        if (!allowed.includes(toolName)) {
          console.error(`[Plugin: ${pname}] blocked removeTool("${toolName}"): not listed in permissions.tools.remove`);
          return;
        }
        plugin.removeTools = plugin.removeTools || [];
        plugin.removeTools.push(toolName);
      },
      unregisterTool: (toolName: string) => {
        const allowed = perms.tools?.remove ?? [];
        if (!allowed.includes(toolName)) {
          console.error(`[Plugin: ${pname}] blocked unregisterTool("${toolName}"): not listed in permissions.tools.remove`);
          return;
        }
        plugin.removeTools = plugin.removeTools || [];
        plugin.removeTools.push(toolName);
      },
    },
    hooks: {
      onBeforeAction: (fn: any) => {
        if (!perms.hooks?.onBeforeAction) {
          console.error(`[Plugin: ${pname}] blocked onBeforeAction hook: permissions.hooks.onBeforeAction not declared`);
          return;
        }
        if (typeof fn === "function") hooks.beforeToolCall.push(fn);
      },
      onAfterAction: (fn: any) => {
        if (!perms.hooks?.onAfterAction) {
          console.error(`[Plugin: ${pname}] blocked onAfterAction hook: permissions.hooks.onAfterAction not declared`);
          return;
        }
        if (typeof fn === "function") {
          hooks.afterToolCall.push(async (toolName, args, result, session) => {
            return await fn(toolName, result, session, args);
          });
        }
      },
      onDOMMutation: (fn: any) => {
        if (!perms.hooks?.onDOMMutation) {
          console.error(`[Plugin: ${pname}] blocked onDOMMutation hook: permissions.hooks.onDOMMutation not declared`);
          return;
        }
        if (typeof fn === "function") (hooks as any).onDOMMutation?.push(fn);
      },
      beforeToolCall: (fn) => {
        if (!perms.hooks?.onBeforeAction) {
          console.error(`[Plugin: ${pname}] blocked beforeToolCall hook: permissions.hooks.onBeforeAction not declared`);
          return;
        }
        if (typeof fn === "function") hooks.beforeToolCall.push(fn);
      },
      afterToolCall: (fn) => {
        if (!perms.hooks?.onAfterAction) {
          console.error(`[Plugin: ${pname}] blocked afterToolCall hook: permissions.hooks.onAfterAction not declared`);
          return;
        }
        if (typeof fn === "function") hooks.afterToolCall.push(fn);
      },
      onPageNavigate: (fn) => {
        if (!perms.hooks?.onPageNavigate) {
          console.error(`[Plugin: ${pname}] blocked onPageNavigate hook: permissions.hooks.onPageNavigate not declared`);
          return;
        }
        if (typeof fn === "function") hooks.onPageNavigate.push(fn);
      },
    },
    memory: {
      getSiteProfile: (origin: string) => getSiteProfile(origin),
      learnPattern: (origin: string, name: string, pattern: any) => learnPattern(origin, name, pattern),
      recordExecution: (origin: string, name: string, success: boolean, durationMs?: number) => recordPatternExecution(origin, name, success, durationMs),
      getReliability: (origin: string, patternName: string) => getPatternReliability(origin, patternName),
      recordQuirk: (origin: string, quirkKey: string, quirkData: any) => recordQuirk(origin, quirkKey, quirkData),
    },
    logger: {
      info: (...args: any[]) => console.error(`[Plugin: ${pname}] [INFO]`, ...args),
      warn: (...args: any[]) => console.error(`[Plugin: ${pname}] [WARN]`, ...args),
      error: (...args: any[]) => console.error(`[Plugin: ${pname}] [ERROR]`, ...args),
      debug: (...args: any[]) => console.error(`[Plugin: ${pname}] [DEBUG]`, ...args),
    },
  };
}

/**
 * Attempt to load a single package as a Weavetab plugin for MCP server execution.
 * The presence of weavetab.json is the ONLY requirement — any package name works.
 * Constructs the rich PluginContext WITHOUT executing onLoad eagerly.
 */
function tryLoadPlugin(pkgDir: string): WeavetabPlugin | null {
  const manifestPath = join(pkgDir, "weavetab.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const rawManifest = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(rawManifest) as WeavetabManifest;

    // Check engine compatibility
    if (manifest.engines?.weavetab) {
      const compat = checkEngineCompatibility(manifest.engines.weavetab);
      if (!compat.compatible) {
        console.error(`[Weavetab] Warning: ${compat.message}`);
      }
    }

    let pkg: Record<string, any> = {};
    const pkgPath = join(pkgDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      } catch { /* malformed package.json */ }
    }

    // Resolve entry point: manifest.entry > pkg.main > "dist/index.js" > "index.js"
    let entryFile = manifest.entry || pkg.main;
    if (!entryFile) {
      if (existsSync(join(pkgDir, "dist", "index.js"))) {
        entryFile = "dist/index.js";
      } else {
        entryFile = "index.js";
      }
    }

    const resolvedEntry = join(pkgDir, entryFile);
    if (!existsSync(resolvedEntry)) {
      console.error(`[Weavetab] Plugin entry point not found: ${resolvedEntry}`);
      return null;
    }

    const pluginModule = require(resolvedEntry);
    const plugin = pluginModule.default || pluginModule.plugin || pluginModule;

    const rawPerms = Array.isArray(manifest.permissions)
      ? manifest.permissions
      : { ...(plugin?.permissions || {}), ...(manifest?.permissions || {}) };
    const normalizedPerms = normalizePermissions(rawPerms);

    if (
      plugin &&
      (Array.isArray(plugin.tools) ||
        Array.isArray(plugin.overrides) ||
        Array.isArray(plugin.removeTools) ||
        typeof plugin.onBeforeAction === "function" ||
        typeof plugin.onAfterAction === "function" ||
        typeof plugin.onDOMMutation === "function" ||
        Boolean(normalizedPerms?.tools) ||
        typeof plugin.onLoad === "function")
    ) {
      plugin.name = plugin.name || manifest.name || pkg.name || basename(pkgDir);
      plugin.version = plugin.version || manifest.version || pkg.version || "1.0.0";
      plugin.description = plugin.description || manifest.description || pkg.description || "";
      plugin.manifest = manifest;
      plugin.permissions = normalizedPerms;
      plugin.manifest.permissions = normalizedPerms;
      plugin.tools = Array.isArray(plugin.tools) ? plugin.tools : [];
      plugin.overrides = Array.isArray(plugin.overrides) ? plugin.overrides : [];

      plugin.removeTools = Array.isArray(plugin.removeTools)
        ? plugin.removeTools
        : normalizedPerms.tools?.remove || [];

      // Initialize isolated storage sandbox in ~/.weavetab/plugins/<plugin-name>/
      const storageManager = new PluginStorageManager(plugin.name);
      const extensionBridge = new PluginExtensionBridge(plugin.name, normalizedPerms);
      const pluginConfig = storageManager.loadConfig(plugin.defaultConfig || manifest.defaultConfig || {});

      const hooks = {
        beforeToolCall: [] as Array<(toolName: string, args: Record<string, any>, session?: any) => Promise<any> | void>,
        afterToolCall: [] as Array<(toolName: string, args: Record<string, any>, result: any, session?: any) => Promise<any> | void>,
        onDOMMutation: [] as Array<(delta: any, session?: any) => Promise<void> | void>,
        onPageNavigate: [] as Array<(url: string, session?: any) => Promise<void> | void>,
      };

      // Top-level plugin definition hooks
      if (typeof plugin.onBeforeAction === "function") {
        hooks.beforeToolCall.push(plugin.onBeforeAction);
      }
      if (typeof plugin.onAfterAction === "function") {
        hooks.afterToolCall.push(async (toolName, args, result, session) => {
          return await plugin.onAfterAction(toolName, result, session, args);
        });
      }
      if (typeof plugin.onDOMMutation === "function") {
        hooks.onDOMMutation.push(plugin.onDOMMutation);
      }

      plugin.storage = storageManager;
      plugin.extension = extensionBridge;
      plugin.hooks = hooks;

      // Construct authoritative PluginContext
      const pluginContext = buildPluginContext(plugin, storageManager, extensionBridge, pluginConfig, hooks);
      (plugin as any)._context = pluginContext;

      // Note: We do NOT invoke plugin.onLoad here. server.ts is the sole lifecycle owner.
      return plugin as WeavetabPlugin;
    }
  } catch (e: any) {
    console.error(`[Weavetab] Failed loading plugin at ${pkgDir}:`, e?.message || e);
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
          // Scoped package directory (e.g. @weavetab, @acme, @mycompany)
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
          // Top-level package — any name works: my-plugin, wt-github, custom-plugin, etc.
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

      // Check if it's a scoped package (e.g. @scope/name)
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
