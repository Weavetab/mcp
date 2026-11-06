import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join, basename, resolve } from "node:path";
import os from "node:os";
import type { WeavetabPlugin, WeavetabManifest, WeavetabPermissions, PluginContext } from "./interface.js";
import { PluginStorageManager } from "./storage.js";
import { PluginExtensionBridge } from "./extension_bridge.js";
import {
  getSiteProfile,
  learnPattern,
  recordPatternExecution,
  getPatternReliability,
  recordQuirk,
} from "../intelligence/patternCompiler.js";
import { WEAVETAB_VERSION } from "../version.js";

const require = createRequire(import.meta.url);

export const MAX_AGENTS_MD_LINES = 80;
export const MAX_AGENTS_MD_CHARS = 3200;

export interface InstalledPluginInfo {
  packageName: string;
  dir: string;
  manifest: WeavetabManifest;
  pkgJson?: Record<string, any>;
  hasValidManifest: boolean;
  instructions?: string;
  agentsMdContent?: string;
}

export function touchPluginEpoch(): void {
  try {
    const dir = join(os.homedir(), ".weavetab", "plugins");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".epoch"), String(Date.now()), "utf-8");
  } catch {
    // best-effort touch
  }
}

/**
 * Invalidates Node's require.cache for all files inside a package directory,
 * ensuring that reloading a plugin picks up the latest code from disk.
 */
export function invalidatePluginModuleCache(pkgDir: string): void {
  try {
    const norm = resolve(pkgDir);
    for (const modPath of Object.keys(require.cache)) {
      if (modPath.startsWith(norm)) {
        delete require.cache[modPath];
      }
    }
  } catch {
    // best-effort cache purge
  }
}

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

function getWorkspacePluginDirs(): string[] {
  const cwd = process.cwd();
  const candidates = [join(cwd, "plugins"), join(cwd, "..", "plugins")];
  const found: string[] = [];
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const pdir = join(root, entry.name);
        if (existsSync(join(pdir, "weavetab.json"))) {
          found.push(pdir);
        }
      }
    } catch {
      // ignore
    }
  }
  return Array.from(new Set(found));
}

/**
 * Reads AGENTS.md from a plugin directory and strictly clamps it to MAX_AGENTS_MD_LINES
 * and MAX_AGENTS_MD_CHARS so a rogue plugin can never bloat an AI agent's context window.
 */
export function readBoundedAgentsMd(pkgDir: string, manifest?: WeavetabManifest): string | undefined {
  const rel = typeof manifest?.agentsMd === "string" && manifest.agentsMd.trim() ? manifest.agentsMd.trim() : "AGENTS.md";
  const fullPath = join(pkgDir, rel);
  if (!existsSync(fullPath)) return undefined;
  try {
    const raw = readFileSync(fullPath, "utf-8").trim();
    if (!raw) return undefined;
    const lines = raw.split(/\r?\n/);
    const clampedLines = lines.slice(0, MAX_AGENTS_MD_LINES).join("\n");
    return clampedLines.length > MAX_AGENTS_MD_CHARS ? clampedLines.slice(0, MAX_AGENTS_MD_CHARS) : clampedLines;
  } catch {
    return undefined;
  }
}

/**
 * Normalizes permissions format across legacy arrays and object aliases (filesystem vs fs).
 */
export function normalizePermissions(perms?: any): WeavetabPermissions {
  if (!perms) return {};

  // Handle flat string array: ["browser.evaluate", "tools.add", "commands", "fs.read", ...]
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
      } else if (cat === "prompts" || cat === "resources" || cat === "commands") {
        normalized[cat] = { add: true };
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

function checkEngineCompatibility(engineReq?: string): { compatible: boolean; message?: string } {
  if (!engineReq || engineReq === "*" || engineReq === "latest") {
    return { compatible: true };
  }

  const cleanReq = engineReq.replace(/[\^~>=]/g, "").trim();
  const reqParts = cleanReq.split(".").map((p) => parseInt(p, 10));
  const curParts = RUNTIME_VERSION.split("-")[0].split(".").map((p) => parseInt(p, 10));

  if (engineReq.startsWith("^")) {
    if (
      curParts[0] === reqParts[0] &&
      (curParts[1] > reqParts[1] || (curParts[1] === reqParts[1] && curParts[2] >= reqParts[2]))
    ) {
      return { compatible: true };
    }
  } else if (engineReq.startsWith(">=")) {
    if (curParts[0] > reqParts[0] || (curParts[0] === reqParts[0] && curParts[1] >= reqParts[1])) {
      return { compatible: true };
    }
  } else {
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
 * Reads the manifest (weavetab.json), package.json, and AGENTS.md for an installed package
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
      } catch {
        /* malformed package.json */
      }
    }

    const packageName = pkgJson?.name || manifest.name || basename(pkgDir);
    const boundedAgents = readBoundedAgentsMd(pkgDir, manifest);
    const rawInstructions = typeof manifest.instructions === "string" ? manifest.instructions.trim() : "";
    const instructions = rawInstructions
      ? (rawInstructions.length > MAX_AGENTS_MD_CHARS ? rawInstructions.slice(0, MAX_AGENTS_MD_CHARS) : rawInstructions)
      : boundedAgents;

    return {
      packageName,
      dir: pkgDir,
      manifest,
      pkgJson,
      hasValidManifest: true,
      instructions,
      agentsMdContent: boundedAgents || instructions,
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

  // Check workspace plugin directories first for local development precedence
  for (const wsDir of getWorkspacePluginDirs()) {
    const info = inspectInstalledPackage(wsDir);
    if (info && !seenPackages.has(info.packageName)) {
      seenPackages.add(info.packageName);
      results.push(info);
    }
  }

  const modulesDirs = getNodeModulesDirs(pluginDir);

  for (const modulesDir of modulesDirs) {
    try {
      const entries = readdirSync(modulesDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

        if (entry.name.startsWith("@")) {
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
          } catch {
            /* scope dir unreadable */
          }
        } else {
          const info = inspectInstalledPackage(join(modulesDir, entry.name));
          if (info && !seenPackages.has(info.packageName)) {
            seenPackages.add(info.packageName);
            results.push(info);
          }
        }
      }
    } catch {
      /* ignore filesystem errors */
    }
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

  const registerCommand = (cmd: any) => {
    if (!perms.commands?.add) {
      console.error(`[Plugin: ${pname}] blocked registerCommand("${cmd?.name}"): permissions.commands.add not declared`);
      return;
    }
    if (!cmd?.name || typeof cmd.handler !== "function") {
      console.error(`[Plugin: ${pname}] blocked registerCommand: command needs a name and handler()`);
      return;
    }
    plugin.commands = plugin.commands || [];
    const idx = plugin.commands.findIndex((c: any) => c.name === cmd.name);
    if (idx >= 0) plugin.commands[idx] = cmd;
    else plugin.commands.push(cmd);
  };

  const unregisterCommand = (name: string) => {
    if (!plugin.commands) return;
    plugin.commands = plugin.commands.filter((c: any) => c.name !== name);
  };

  return {
    name: pname,
    version: plugin.version,
    pluginDir: storageManager.getDirectory(),
    config: pluginConfig,
    storage: storageManager,
    desktop: {
      listApps: async () => {
        const { discoverElectronApps } = await import("../desktop/discovery.js");
        return await discoverElectronApps();
      },
      getApp: async (name: string) => {
        const { discoverElectronApps } = await import("../desktop/discovery.js");
        const apps = await discoverElectronApps();
        return apps.find((a: any) => a.name.toLowerCase() === name.toLowerCase()) || null;
      },
      getTargets: async (port: number) => {
        const { fetchTargets } = await import("../desktop/discovery.js");
        return await fetchTargets(port);
      },
    },
    extension: extensionBridge,
    cli: {
      registerCommand,
      unregisterCommand,
    },
    mcp: {
      registerPrompt: (prompt: any) => {
        if (!perms.prompts?.add) {
          console.error(`[Plugin: ${pname}] blocked registerPrompt("${prompt?.name}"): permissions.prompts.add not declared`);
          return;
        }
        plugin.prompts = plugin.prompts || [];
        const idx = plugin.prompts.findIndex((p: any) => p.name === prompt.name);
        if (idx >= 0) plugin.prompts[idx] = prompt;
        else plugin.prompts.push(prompt);
      },
      registerResource: (resource: any) => {
        if (!perms.resources?.add) {
          console.error(
            `[Plugin: ${pname}] blocked registerResource("${resource?.name}"): permissions.resources.add not declared`
          );
          return;
        }
        plugin.resources = plugin.resources || [];
        const idx = plugin.resources.findIndex((r: any) => r.name === resource.name);
        if (idx >= 0) plugin.resources[idx] = resource;
        else plugin.resources.push(resource);
      },
      registerCommand,
      unregisterCommand,
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
      recordExecution: (origin: string, name: string, success: boolean, durationMs?: number) =>
        recordPatternExecution(origin, name, success, durationMs),
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
 * Attempt to load a single package directory as a Weavetab plugin.
 */
export function tryLoadPlugin(pkgDir: string): WeavetabPlugin | null {
  const manifestPath = join(pkgDir, "weavetab.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const rawManifest = readFileSync(manifestPath, "utf-8");
    const manifest = JSON.parse(rawManifest) as WeavetabManifest;

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
      } catch {
        /* malformed package.json */
      }
    }

    let entryFile = manifest.entry || pkg.main;
    if (!entryFile) {
      if (existsSync(join(pkgDir, "dist", "index.js"))) {
        entryFile = "dist/index.js";
      } else {
        entryFile = "index.js";
      }
    }

    const resolvedEntry = resolve(pkgDir, entryFile);
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
        Array.isArray(plugin.commands) ||
        Array.isArray(plugin.prompts) ||
        Array.isArray(plugin.resources) ||
        Array.isArray(plugin.overrides) ||
        Array.isArray(plugin.removeTools) ||
        typeof plugin.onBeforeAction === "function" ||
        typeof plugin.onAfterAction === "function" ||
        typeof plugin.onDOMMutation === "function" ||
        Boolean(normalizedPerms?.tools) ||
        Boolean(normalizedPerms?.commands) ||
        Boolean(normalizedPerms?.prompts) ||
        Boolean(normalizedPerms?.resources) ||
        typeof plugin.onLoad === "function")
    ) {
      plugin.name = plugin.name || manifest.name || pkg.name || basename(pkgDir);
      plugin.version = plugin.version || manifest.version || pkg.version || "1.0.0";
      plugin.description = plugin.description || manifest.description || pkg.description || "";
      plugin.manifest = manifest;
      plugin.permissions = normalizedPerms;
      plugin.manifest.permissions = normalizedPerms;
      plugin.tools = Array.isArray(plugin.tools) ? [...plugin.tools] : [];
      plugin.prompts = Array.isArray(plugin.prompts) ? [...plugin.prompts] : [];
      plugin.resources = Array.isArray(plugin.resources) ? [...plugin.resources] : [];
      plugin.overrides = Array.isArray(plugin.overrides) ? [...plugin.overrides] : [];

      if (Array.isArray(plugin.commands) && plugin.commands.length > 0) {
        if (!normalizedPerms.commands?.add) {
          console.error(
            `[Plugin: ${plugin.name}] blocked ${plugin.commands.length} static command(s): permissions.commands.add not declared`
          );
          plugin.commands = [];
        } else {
          plugin.commands = [...plugin.commands];
        }
      } else {
        plugin.commands = [];
      }

      const boundedAgents = readBoundedAgentsMd(pkgDir, manifest);
      const rawManifestInstructions = typeof manifest.instructions === "string" ? manifest.instructions.trim() : "";
      const rawPluginInstructions = typeof plugin.instructions === "string" ? plugin.instructions.trim() : "";
      const chosenInstructions = rawManifestInstructions || rawPluginInstructions || boundedAgents;
      const clampedInstructions = chosenInstructions
        ? (chosenInstructions.length > MAX_AGENTS_MD_CHARS ? chosenInstructions.slice(0, MAX_AGENTS_MD_CHARS) : chosenInstructions)
        : undefined;

      plugin.instructions = clampedInstructions;
      plugin.agentsMdContent = boundedAgents || clampedInstructions;

      plugin.removeTools = Array.isArray(plugin.removeTools)
        ? plugin.removeTools
        : normalizedPerms.tools?.remove || [];

      const storageManager = new PluginStorageManager(plugin.name);
      const extensionBridge = new PluginExtensionBridge(plugin.name, normalizedPerms);
      const pluginConfig = storageManager.loadConfig(plugin.defaultConfig || manifest.defaultConfig || {});

      const rawHooks = plugin.hooks || {};
      const hooks = {
        beforeToolCall: [
          ...(Array.isArray(rawHooks.beforeToolCall)
            ? rawHooks.beforeToolCall
            : rawHooks.beforeToolCall
            ? [rawHooks.beforeToolCall]
            : []),
        ] as Array<(toolName: string, args: Record<string, any>, session?: any) => Promise<any> | void>,
        afterToolCall: [
          ...(Array.isArray(rawHooks.afterToolCall)
            ? rawHooks.afterToolCall
            : rawHooks.afterToolCall
            ? [rawHooks.afterToolCall]
            : []),
        ] as Array<
          (toolName: string, args: Record<string, any>, result: any, session?: any) => Promise<any> | void
        >,
        onDOMMutation: [
          ...(Array.isArray(rawHooks.onDOMMutation)
            ? rawHooks.onDOMMutation
            : rawHooks.onDOMMutation
            ? [rawHooks.onDOMMutation]
            : []),
        ] as Array<(delta: any, session?: any) => Promise<void> | void>,
        onPageNavigate: [
          ...(Array.isArray(rawHooks.onPageNavigate)
            ? rawHooks.onPageNavigate
            : rawHooks.onPageNavigate
            ? [rawHooks.onPageNavigate]
            : []),
        ] as Array<(url: string, session?: any) => Promise<void> | void>,
      };

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

      const pluginContext = buildPluginContext(plugin, storageManager, extensionBridge, pluginConfig, hooks);
      (plugin as any)._context = pluginContext;

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
          } catch {
            /* scope dir unreadable */
          }
        } else {
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

function matchesPluginQuery(info: InstalledPluginInfo, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  const pkg = info.packageName.toLowerCase();
  const unscoped = pkg.replace(/^@[^/]+\//, "");
  const shortSlug = unscoped.replace(/^(weavetab-plugin-|plugin-|wt-)/, "");
  const mname = (info.manifest?.name || "").toLowerCase();
  const mdisplay = (info.manifest?.displayName || "").toLowerCase();
  const dirBase = basename(info.dir).toLowerCase();

  return (
    pkg === q ||
    unscoped === q ||
    shortSlug === q ||
    mname === q ||
    mdisplay === q ||
    dirBase === q ||
    `@weavetab/${q}` === pkg ||
    `@weavetab/plugin-${q}` === pkg ||
    `@weavetab/wt-${q}` === pkg
  );
}

/**
 * Resolves an installed (or workspace) plugin info record by package name, short slug, or display name.
 */
export function resolveInstalledPluginInfo(query: string, pluginDir?: string): InstalledPluginInfo | null {
  const installed = listInstalledPlugins(pluginDir);
  const found = installed.find((p) => matchesPluginQuery(p, query));
  if (found) return found;

  if (!pluginDir) {
    for (const wsDir of getWorkspacePluginDirs()) {
      const info = inspectInstalledPackage(wsDir);
      if (info && matchesPluginQuery(info, query)) {
        return info;
      }
    }
  }
  return null;
}

/**
 * Loads a specific plugin by package name or short slug, initializing onLoad() so dynamic
 * tools, CLI commands, and utilities are populated.
 */
export async function loadAndInitPlugin(query: string, pluginDir?: string): Promise<{ plugin: WeavetabPlugin; info: InstalledPluginInfo } | null> {
  const info = resolveInstalledPluginInfo(query, pluginDir);
  if (!info) return null;
  const plugin = tryLoadPlugin(info.dir);
  if (!plugin) return null;
  if (typeof plugin.onLoad === "function") {
    const ctx = (plugin as any)._context;
    await plugin.onLoad(ctx);
  }
  return { plugin, info };
}

/**
 * Loads a specific plugin by name from node_modules (without calling onLoad).
 */
export function loadPluginByName(name: string, pluginDir?: string): WeavetabPlugin | null {
  try {
    const info = resolveInstalledPluginInfo(name, pluginDir);
    if (info) {
      return tryLoadPlugin(info.dir);
    }
  } catch {
    // Ignore
  }
  return null;
}

export function getPluginCommands(
  plugin: WeavetabPlugin
): Array<{ name: string; description: string; usage: string; requiresSession?: boolean }> {
  const map = new Map<string, { name: string; description: string; usage: string; requiresSession?: boolean }>();
  if (Array.isArray(plugin.manifest?.commands)) {
    for (const c of plugin.manifest.commands) {
      if (c && c.name) {
        map.set(c.name, {
          name: c.name,
          description: c.description || "",
          usage: c.usage || `weavetab plugin use ${plugin.name} ${c.name}`,
          requiresSession: c.requiresSession,
        });
      }
    }
  }
  if (Array.isArray(plugin.commands)) {
    for (const c of plugin.commands) {
      if (c && c.name) {
        const existing = map.get(c.name);
        map.set(c.name, {
          name: c.name,
          description: c.description || existing?.description || "",
          usage: c.usage || existing?.usage || `weavetab plugin use ${plugin.name} ${c.name}`,
          requiresSession: c.requiresSession ?? existing?.requiresSession,
        });
      }
    }
  }
  return Array.from(map.values());
}

export function buildPluginInstructions(plugins: Iterable<WeavetabPlugin>): string {
  const sections: string[] = [];
  const allCmds: Array<{ plugin: string; name: string; description: string; usage: string }> = [];
  const pluginInstructionsList: Array<{ name: string; version: string; instructions: string }> = [];

  for (const pl of plugins) {
    const cmds = getPluginCommands(pl);
    for (const cmd of cmds) {
      allCmds.push({
        plugin: pl.name,
        name: cmd.name,
        description: cmd.description,
        usage: cmd.usage,
      });
    }
    const text = pl.instructions || pl.agentsMdContent;
    if (text && text.trim()) {
      pluginInstructionsList.push({
        name: pl.name,
        version: pl.version || "1.0.0",
        instructions: text.trim(),
      });
    }
  }

  if (allCmds.length > 0) {
    sections.push(
      "## Weavetab Plugin CLI Commands\n" +
        "The following terminal commands are exposed by active Weavetab plugins. " +
        "Run them using terminal execution (`run_command`):\n" +
        allCmds.map((c) => `- \`${c.usage}\`: ${c.description}`).join("\n")
    );
  }

  if (pluginInstructionsList.length > 0) {
    sections.push(
      "## Active Plugin Instructions\n" +
        pluginInstructionsList.map((p) => `### ${p.name} (v${p.version})\n${p.instructions}`).join("\n\n")
    );
  }

  return sections.join("\n\n");
}
