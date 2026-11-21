import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync, renameSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join, basename, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
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
let esmBustSeq = 0;

export const MAX_INSTRUCTIONS_LINES = 80;
export const MAX_INSTRUCTIONS_CHARS = 3200;

export interface InstalledPluginInfo {
  packageName: string;
  dir: string;
  manifest: WeavetabManifest;
  pkgJson?: Record<string, any>;
  hasValidManifest: boolean;
  instructions?: string;
}

function getPluginsRootDir(): string {
  return join(os.homedir(), ".weavetab", "plugins");
}

function getPluginStatePath(): string {
  return join(getPluginsRootDir(), "state.json");
}

export function getDisabledPlugins(): Set<string> {
  try {
    const p = getPluginStatePath();
    if (!existsSync(p)) return new Set();
    const raw = JSON.parse(readFileSync(p, "utf-8"));
    if (Array.isArray(raw?.disabled)) {
      return new Set(raw.disabled.filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0));
    }
  } catch {
    // malformed or unreadable state file -> treat all plugins as enabled
  }
  return new Set();
}

export function isPluginDisabled(pkgName: string): boolean {
  return getDisabledPlugins().has(pkgName);
}

export function setPluginEnabled(pkgName: string, enabled: boolean): void {
  const dir = getPluginsRootDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const disabled = getDisabledPlugins();
  if (enabled) disabled.delete(pkgName);
  else disabled.add(pkgName);

  const target = getPluginStatePath();
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ disabled: Array.from(disabled).sort() }, null, 2), "utf-8");
    renameSync(tmp, target);
  } catch (e) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw e;
  }
  touchPluginEpoch();
}

export function touchPluginEpoch(): void {
  try {
    const dir = getPluginsRootDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".epoch"), String(Date.now()), "utf-8");
  } catch {
    // best-effort touch
  }
}

function normalizeCachePath(p: string): string {
  const forward = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" || process.platform === "darwin" ? forward.toLowerCase() : forward;
}

/**
 * Invalidates Node's require.cache for all files inside a package directory,
 * ensuring that reloading a plugin picks up the latest code from disk across Windows, macOS, and Linux.
 */
export function invalidatePluginModuleCache(pkgDir: string): void {
  try {
    const resolved = resolve(pkgDir);
    const real = existsSync(resolved) ? realpathSync(resolved) : resolved;
    const prefixes = Array.from(new Set([normalizeCachePath(resolved), normalizeCachePath(real)]));

    for (const modPath of Object.keys(require.cache)) {
      const normMod = normalizeCachePath(modPath);
      if (prefixes.some((pref) => normMod === pref || normMod.startsWith(pref + "/"))) {
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
  if (process.env.WT_ALLOW_WORKSPACE_PLUGINS !== "1") return [];
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
 * Strictly clamps plugin instructions from weavetab.json to MAX_INSTRUCTIONS_LINES
 * and MAX_INSTRUCTIONS_CHARS so a plugin can never bloat an AI agent's context window.
 */
export function clampPluginInstructions(raw?: string): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/);
  const clampedLines = lines.slice(0, MAX_INSTRUCTIONS_LINES).join("\n");
  return clampedLines.length > MAX_INSTRUCTIONS_CHARS ? clampedLines.slice(0, MAX_INSTRUCTIONS_CHARS) : clampedLines;
}

export function normalizePermissions(perms?: any): WeavetabPermissions {
  if (!perms) return {};

  // flat string array: ["browser.evaluate", "tools.add", "commands", "fs.read", ...]
  if (Array.isArray(perms)) {
    const out: WeavetabPermissions = {};
    for (const item of perms) {
      if (typeof item !== "string") continue;
      const [cat, sub] = item.split(".");
      if (cat === "browser" || cat === "cdp") {
        out.cdp = out.cdp || {};
        (out.cdp as any)[sub || "evaluate"] = true;
      } else if (cat === "fs" || cat === "filesystem") {
        out.fs = out.fs || {};
        out.filesystem = out.filesystem || {};
        (out.fs as any)[sub || "read"] = ["*"];
        (out.filesystem as any)[sub || "read"] = ["*"];
      } else if (cat === "extension" || cat === "hud") {
        out.extension = out.extension || {};
        (out.extension as any)[sub || "hud"] = true;
      } else if (cat === "network") {
        out.network = out.network || {};
        if (!sub || sub === "intercept") out.network.intercept = true;
        else (out.network as any)[sub] = true;
      } else if (cat === "config") {
        out.config = out.config || {};
        (out.config as any)[sub || "read"] = true;
      } else if (cat === "desktop") {
        out.desktop = out.desktop || {};
        if (sub) out.desktop.apps = [...(out.desktop.apps || []), sub];
      } else if (cat === "prompts" || cat === "resources" || cat === "commands") {
        out[cat] = { add: true };
      } else if (cat === "tools") {
        out.tools = out.tools || {};
        if (!sub || sub === "add") {
          out.tools.add = true;
        }
      } else if (cat === "hooks") {
        out.hooks = out.hooks || {};
        if (sub) {
          (out.hooks as any)[sub] = true;
        } else {
          out.hooks.onBeforeAction = true;
          out.hooks.onAfterAction = true;
        }
      }
    }
    return out;
  }

  if (typeof perms !== "object") return {};
  const out: WeavetabPermissions = { ...perms };

  if (perms.filesystem && !perms.fs) {
    out.fs = perms.filesystem;
  } else if (perms.fs && !perms.filesystem) {
    out.filesystem = perms.fs;
  }

  return out;
}

function parseSemverTuple(ver: string): [number, number, number] {
  const clean = ver.trim().split("-")[0];
  const parts = clean.split(".").map((p) => parseInt(p, 10));
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ];
}

function compareTuple(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function satisfiesSingleClause(cur: [number, number, number], clause: string): boolean {
  const c = clause.trim();
  if (!c || c === "*" || c === "latest") return true;

  if (c.startsWith("^")) {
    const req = parseSemverTuple(c.slice(1));
    if (req[0] > 0) {
      return cur[0] === req[0] && compareTuple(cur, req) >= 0;
    }
    if (req[1] > 0) {
      return cur[0] === 0 && cur[1] === req[1] && cur[2] >= req[2];
    }
    return cur[0] === 0 && cur[1] === 0 && cur[2] === req[2];
  }
  if (c.startsWith("~")) {
    const req = parseSemverTuple(c.slice(1));
    return cur[0] === req[0] && cur[1] === req[1] && cur[2] >= req[2];
  }
  if (c.startsWith(">=")) {
    const req = parseSemverTuple(c.slice(2));
    return compareTuple(cur, req) >= 0;
  }
  if (c.startsWith("<=")) {
    const req = parseSemverTuple(c.slice(2));
    return compareTuple(cur, req) <= 0;
  }
  if (c.startsWith(">")) {
    const req = parseSemverTuple(c.slice(1));
    return compareTuple(cur, req) > 0;
  }
  if (c.startsWith("<")) {
    const req = parseSemverTuple(c.slice(1));
    return compareTuple(cur, req) < 0;
  }
  if (c.startsWith("=")) {
    const req = parseSemverTuple(c.slice(1));
    return compareTuple(cur, req) === 0;
  }

  const rawParts = c.split(".");
  const req = parseSemverTuple(c);
  if (rawParts.length === 1) return cur[0] === req[0];
  if (rawParts.length === 2) return cur[0] === req[0] && cur[1] === req[1];
  return compareTuple(cur, req) === 0;
}

export function checkEngineCompatibility(
  engineReq?: string,
  runtimeVer: string = RUNTIME_VERSION
): { compatible: boolean; message?: string } {
  if (!engineReq || engineReq.trim() === "*" || engineReq.trim() === "latest") {
    return { compatible: true };
  }

  const cur = parseSemverTuple(runtimeVer);
  const clauses = engineReq.trim().split(/\s+/).filter(Boolean);
  if (clauses.every((clause) => satisfiesSingleClause(cur, clause))) {
    return { compatible: true };
  }

  return {
    compatible: false,
    message: `Plugin requires Weavetab version ${engineReq}, but current runtime is ${runtimeVer}.`,
  };
}

export function inspectInstalledPackage(pkgDir: string): InstalledPluginInfo | null {
  const manifestPath = join(pkgDir, "weavetab.json");
  if (!existsSync(manifestPath)) return null;

  try {
    const rawManifest = readFileSync(manifestPath, "utf-8");
    const parsed = JSON.parse(rawManifest);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const manifest = parsed as WeavetabManifest;
    if (manifest.name !== undefined && (typeof manifest.name !== "string" || !manifest.name.trim())) {
      return null;
    }

    let pkgJson: Record<string, any> | undefined;
    const pkgPath = join(pkgDir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        pkgJson = JSON.parse(readFileSync(pkgPath, "utf-8"));
      } catch {
        // malformed package.json
      }
    }

    const packageName = pkgJson?.name || manifest.name || basename(pkgDir);
    const instructions = clampPluginInstructions(manifest.instructions);

    return {
      packageName,
      dir: pkgDir,
      manifest,
      pkgJson,
      hasValidManifest: true,
      instructions,
    };
  } catch {
    return null;
  }
}

function scanNodeModulesPluginDirs(pluginDir?: string): string[] {
  const dirs: string[] = [];
  for (const modulesDir of getNodeModulesDirs(pluginDir)) {
    try {
      for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (entry.name.startsWith("@")) {
          const scopeDir = join(modulesDir, entry.name);
          try {
            for (const scopeEntry of readdirSync(scopeDir, { withFileTypes: true })) {
              if (!scopeEntry.isDirectory() && !scopeEntry.isSymbolicLink()) continue;
              dirs.push(join(scopeDir, scopeEntry.name));
            }
          } catch {
            // scope dir unreadable
          }
        } else {
          dirs.push(join(modulesDir, entry.name));
        }
      }
    } catch {
      // node_modules missing or unreadable
    }
  }
  return dirs;
}

export function listInstalledPlugins(pluginDir?: string): InstalledPluginInfo[] {
  const results: InstalledPluginInfo[] = [];
  const seenPackages = new Set<string>();

  const candidates = pluginDir
    ? scanNodeModulesPluginDirs(pluginDir)
    : [...getWorkspacePluginDirs(), ...scanNodeModulesPluginDirs()];

  for (const pdir of candidates) {
    const info = inspectInstalledPackage(pdir);
    if (info && !seenPackages.has(info.packageName)) {
      seenPackages.add(info.packageName);
      results.push(info);
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
    onDOMMutation?: Array<(delta: any, session?: any) => Promise<void> | void>;
    onPageNavigate: Array<(url: string, session?: any) => Promise<void> | void>;
  }
): PluginContext {
  const perms = normalizePermissions(plugin.manifest?.permissions);
  const pname = plugin.name;
  if (!Array.isArray(hooks.onDOMMutation)) {
    hooks.onDOMMutation = [];
  }

  const canBeforeHook = Boolean(perms.hooks?.onBeforeAction || (perms.hooks as any)?.beforeToolCall);
  const canAfterHook = Boolean(perms.hooks?.onAfterAction || (perms.hooks as any)?.afterToolCall);

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

  const getDesktopApp = async (name: string) => {
    const { discoverElectronApps, normalizeElectronAppName } = await import("../desktop/discovery.js");
    const apps = await discoverElectronApps();
    const target = normalizeElectronAppName(name);
    return apps.find((a: any) => normalizeElectronAppName(a.name) === target) || null;
  };

  return {
    name: pname,
    version: plugin.version,
    pluginDir: storageManager.getDirectory(),
    config: pluginConfig,
    storage: storageManager,
    desktop: {
      isAvailable: () => true,
      listApps: async () => {
        const { discoverElectronApps } = await import("../desktop/discovery.js");
        return await discoverElectronApps();
      },
      getApp: getDesktopApp,
      getTargets: async (portOrName: number | string) => {
        const { fetchTargets } = await import("../desktop/discovery.js");
        if (typeof portOrName === "number") {
          return await fetchTargets(portOrName);
        }
        const app = await getDesktopApp(String(portOrName));
        if (!app || !app.port) return [];
        return await fetchTargets(app.port);
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
        if (!prompt?.name || typeof prompt.handler !== "function") {
          console.error(`[Plugin: ${pname}] blocked registerPrompt: prompt needs a name and handler()`);
          return;
        }
        plugin.prompts = plugin.prompts || [];
        const idx = plugin.prompts.findIndex((p: any) => p.name === prompt.name);
        if (idx >= 0) plugin.prompts[idx] = prompt;
        else plugin.prompts.push(prompt);
      },
      unregisterPrompt: (name: string) => {
        if (!plugin.prompts) return;
        plugin.prompts = plugin.prompts.filter((p: any) => p.name !== name);
      },
      registerResource: (resource: any) => {
        if (!perms.resources?.add) {
          console.error(
            `[Plugin: ${pname}] blocked registerResource("${resource?.name}"): permissions.resources.add not declared`
          );
          return;
        }
        if (!resource?.name || typeof resource.read !== "function") {
          console.error(`[Plugin: ${pname}] blocked registerResource: resource needs a name and read()`);
          return;
        }
        plugin.resources = plugin.resources || [];
        const idx = plugin.resources.findIndex((r: any) => r.name === resource.name);
        if (idx >= 0) plugin.resources[idx] = resource;
        else plugin.resources.push(resource);
      },
      unregisterResource: (uriOrName: string) => {
        if (!plugin.resources) return;
        plugin.resources = plugin.resources.filter((r: any) => r.name !== uriOrName && r.uri !== uriOrName);
      },
      registerCommand,
      unregisterCommand,
      registerTool: (tool: any) => {
        if (!perms.tools?.add) {
          console.error(`[Plugin: ${pname}] blocked registerTool("${tool?.name}"): permissions.tools.add not declared`);
          return;
        }
        if (!tool?.name || typeof tool.handler !== "function") {
          console.error(`[Plugin: ${pname}] blocked registerTool: tool needs a name and handler()`);
          return;
        }
        plugin.tools = plugin.tools || [];
        const idx = plugin.tools.findIndex((t: any) => t.name === tool.name);
        if (idx >= 0) plugin.tools[idx] = tool;
        else plugin.tools.push(tool);
      },
      overrideTool: (toolName: string, overrideHandler: any) => {
        const allowed = perms.tools?.override ?? [];
        if (!allowed.includes(toolName)) {
          console.error(`[Plugin: ${pname}] blocked overrideTool("${toolName}"): not listed in permissions.tools.override`);
          return;
        }
        const ov =
          typeof overrideHandler === "function"
            ? { name: toolName, handler: overrideHandler }
            : { ...overrideHandler, name: toolName };
        plugin.overrides = plugin.overrides || [];
        const idx = plugin.overrides.findIndex((o) => o.name === toolName);
        if (idx >= 0) plugin.overrides[idx] = ov;
        else plugin.overrides.push(ov);
      },
      removeTool: (toolName: string) => {
        const allowed = perms.tools?.remove ?? [];
        if (!allowed.includes(toolName)) {
          console.error(`[Plugin: ${pname}] blocked removeTool("${toolName}"): not listed in permissions.tools.remove`);
          return;
        }
        plugin.removeTools = plugin.removeTools || [];
        if (!plugin.removeTools.includes(toolName)) plugin.removeTools.push(toolName);
      },
      unregisterTool: (toolName: string) => {
        const allowed = perms.tools?.remove ?? [];
        if (!allowed.includes(toolName)) {
          console.error(`[Plugin: ${pname}] blocked unregisterTool("${toolName}"): not listed in permissions.tools.remove`);
          return;
        }
        plugin.removeTools = plugin.removeTools || [];
        if (!plugin.removeTools.includes(toolName)) plugin.removeTools.push(toolName);
      },
    },
    hooks: {
      onBeforeAction: (fn: any) => {
        if (!canBeforeHook) {
          console.error(`[Plugin: ${pname}] blocked onBeforeAction hook: permissions.hooks.onBeforeAction not declared`);
          return;
        }
        if (typeof fn === "function") hooks.beforeToolCall.push(fn);
      },
      onAfterAction: (fn: any) => {
        if (!canAfterHook) {
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
        if (typeof fn === "function") hooks.onDOMMutation!.push(fn);
      },
      beforeToolCall: (fn) => {
        if (!canBeforeHook) {
          console.error(`[Plugin: ${pname}] blocked beforeToolCall hook: permissions.hooks.onBeforeAction not declared`);
          return;
        }
        if (typeof fn === "function") hooks.beforeToolCall.push(fn);
      },
      afterToolCall: (fn) => {
        if (!canAfterHook) {
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
    logger: {
      info: (...args: any[]) => console.error(`[Plugin: ${pname}] [INFO]`, ...args),
      warn: (...args: any[]) => console.error(`[Plugin: ${pname}] [WARN]`, ...args),
      error: (...args: any[]) => console.error(`[Plugin: ${pname}] [ERROR]`, ...args),
      debug: (...args: any[]) => console.error(`[Plugin: ${pname}] [DEBUG]`, ...args),
    },
  };
}

export function resolvePluginEntry(pkgDir: string, manifest?: WeavetabManifest, pkg?: Record<string, any>): string | null {
  let entryFile = manifest?.entry || pkg?.main;
  if (!entryFile) {
    entryFile = existsSync(join(pkgDir, "dist", "index.js")) ? "dist/index.js" : "index.js";
  }

  const resolvedEntry = resolve(pkgDir, entryFile);
  if (!existsSync(resolvedEntry)) return null;

  const realPkgDir = realpathSync(pkgDir);
  const realPkgPrefix = realPkgDir.endsWith(sep) ? realPkgDir : realPkgDir + sep;
  const realEntry = realpathSync(resolvedEntry);
  if (!realEntry.startsWith(realPkgPrefix)) {
    throw new Error(`Security Violation: Plugin entry "${entryFile}" escapes package directory ${pkgDir}`);
  }
  return realEntry;
}

interface PreparedPluginLoad {
  manifest: WeavetabManifest;
  pkg: Record<string, any>;
  realEntry: string;
  isEsm: boolean;
}

function preparePluginLoad(pkgDir: string): PreparedPluginLoad | null {
  const manifestPath = join(pkgDir, "weavetab.json");
  if (!existsSync(manifestPath)) return null;

  const rawManifest = readFileSync(manifestPath, "utf-8");
  const parsed = JSON.parse(rawManifest);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`[Weavetab] Invalid weavetab.json at ${pkgDir}`);
    return null;
  }
  const manifest = parsed as WeavetabManifest;

  let pkg: Record<string, any> = {};
  const pkgPath = join(pkgDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    } catch {
      // malformed package.json
    }
  }

  const sdkRange =
    pkg.dependencies?.["@weavetab/sdk"] ||
    pkg.peerDependencies?.["@weavetab/sdk"] ||
    pkg.devDependencies?.["@weavetab/sdk"] ||
    manifest.engines?.weavetab;
  if (sdkRange) {
    const compat = checkEngineCompatibility(sdkRange);
    if (!compat.compatible) {
      console.error(`[Weavetab] Warning: ${compat.message}`);
    }
  }

  const realEntry = resolvePluginEntry(pkgDir, manifest, pkg);
  if (!realEntry) {
    console.error(`[Weavetab] Plugin entry point not found in ${pkgDir}`);
    return null;
  }

  const isEsm =
    realEntry.endsWith(".mjs") ||
    (!realEntry.endsWith(".cjs") && pkg.type === "module");

  return { manifest, pkg, realEntry, isEsm };
}

function hydrateLoadedPlugin(
  pluginModule: any,
  manifest: WeavetabManifest,
  pkg: Record<string, any>,
  pkgDir: string
): WeavetabPlugin | null {
  const rawExport = pluginModule?.default || pluginModule?.plugin || pluginModule;
  if (!rawExport || typeof rawExport !== "object") return null;

  // clone so ESM module namespace objects are never mutated directly
  const plugin: any = { ...rawExport };
  const normalizedPerms = normalizePermissions(manifest.permissions);

  const hasSurface =
    Array.isArray(plugin.tools) ||
    Array.isArray(plugin.commands) ||
    Array.isArray(plugin.prompts) ||
    Array.isArray(plugin.resources) ||
    Array.isArray(plugin.overrides) ||
    Array.isArray(plugin.removeTools) ||
    Boolean(plugin.hooks && typeof plugin.hooks === "object") ||
    typeof plugin.onBeforeAction === "function" ||
    typeof plugin.onAfterAction === "function" ||
    typeof plugin.onDOMMutation === "function" ||
    typeof plugin.onPageNavigate === "function" ||
    Boolean(normalizedPerms?.tools) ||
    Boolean(normalizedPerms?.commands) ||
    Boolean(normalizedPerms?.prompts) ||
    Boolean(normalizedPerms?.resources) ||
    Boolean(normalizedPerms?.hooks) ||
    typeof plugin.onLoad === "function";

  if (!hasSurface) return null;

  plugin.name = pkg.name || manifest.name || basename(pkgDir);
  plugin.version = pkg.version || plugin.version || manifest.version || "1.0.0";
  plugin.description = manifest.description || plugin.description || pkg.description || "";
  plugin.manifest = { ...manifest, permissions: normalizedPerms };
  plugin.permissions = normalizedPerms;
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

  const rawManifestInstructions = typeof manifest.instructions === "string" ? manifest.instructions.trim() : "";
  const rawPluginInstructions = typeof plugin.instructions === "string" ? plugin.instructions.trim() : "";
  plugin.instructions = clampPluginInstructions(rawManifestInstructions || rawPluginInstructions);

  plugin.removeTools = Array.isArray(plugin.removeTools)
    ? [...plugin.removeTools]
    : normalizedPerms.tools?.remove || [];

  const storageManager = new PluginStorageManager(plugin.name);
  const extensionBridge = new PluginExtensionBridge(plugin.name, normalizedPerms);
  const pluginConfig = storageManager.loadConfig(plugin.defaultConfig || manifest.defaultConfig || {});

  const rawHooks = plugin.hooks || {};
  const canBeforeHook = Boolean(
    normalizedPerms.hooks?.onBeforeAction || (normalizedPerms.hooks as any)?.beforeToolCall
  );
  const canAfterHook = Boolean(
    normalizedPerms.hooks?.onAfterAction || (normalizedPerms.hooks as any)?.afterToolCall
  );
  const canDOMHook = Boolean(normalizedPerms.hooks?.onDOMMutation);
  const canNavHook = Boolean(normalizedPerms.hooks?.onPageNavigate);

  const toList = (val: any) => (Array.isArray(val) ? val : val ? [val] : []);

  const rawBeforeList = [...toList(rawHooks.beforeToolCall), ...toList(rawHooks.onBeforeAction)];
  if (typeof plugin.onBeforeAction === "function") rawBeforeList.push(plugin.onBeforeAction);

  const rawAfterList = [...toList(rawHooks.afterToolCall)];
  const rawOnAfterActionList = [...toList(rawHooks.onAfterAction)];
  if (typeof plugin.onAfterAction === "function") rawOnAfterActionList.push(plugin.onAfterAction);
  for (const fn of rawOnAfterActionList) {
    if (typeof fn === "function") {
      rawAfterList.push(async (toolName: string, args: Record<string, any>, result: any, session?: any) => {
        return await fn(toolName, result, session, args);
      });
    }
  }

  const rawDOMList = [...toList(rawHooks.onDOMMutation)];
  if (typeof plugin.onDOMMutation === "function") rawDOMList.push(plugin.onDOMMutation);

  const rawNavList = [...toList(rawHooks.onPageNavigate)];
  if (typeof plugin.onPageNavigate === "function") rawNavList.push(plugin.onPageNavigate);

  const hooks = {
    beforeToolCall: (canBeforeHook ? rawBeforeList : []) as Array<
      (toolName: string, args: Record<string, any>, session?: any) => Promise<any> | void
    >,
    afterToolCall: (canAfterHook ? rawAfterList : []) as Array<
      (toolName: string, args: Record<string, any>, result: any, session?: any) => Promise<any> | void
    >,
    onDOMMutation: (canDOMHook ? rawDOMList : []) as Array<(delta: any, session?: any) => Promise<void> | void>,
    onPageNavigate: (canNavHook ? rawNavList : []) as Array<(url: string, session?: any) => Promise<void> | void>,
  };

  delete plugin.onBeforeAction;
  delete plugin.onAfterAction;
  delete plugin.onDOMMutation;
  delete plugin.onPageNavigate;

  plugin.storage = storageManager;
  plugin.extension = extensionBridge;
  plugin.hooks = hooks;
  plugin._context = buildPluginContext(plugin, storageManager, extensionBridge, pluginConfig, hooks);

  return plugin as WeavetabPlugin;
}

export function tryLoadPlugin(pkgDir: string): WeavetabPlugin | null {
  try {
    const prep = preparePluginLoad(pkgDir);
    if (!prep) return null;
    const mod = require(prep.realEntry);
    return hydrateLoadedPlugin(mod, prep.manifest, prep.pkg, pkgDir);
  } catch (e: any) {
    console.error(`[Weavetab] Failed loading plugin at ${pkgDir}:`, e?.message || e);
    return null;
  }
}

export async function tryLoadPluginAsync(pkgDir: string, bustCache = false): Promise<WeavetabPlugin | null> {
  try {
    const prep = preparePluginLoad(pkgDir);
    if (!prep) return null;

    let mod: any;
    if (prep.isEsm) {
      const baseUrl = pathToFileURL(prep.realEntry).href;
      const spec = bustCache ? `${baseUrl}?wt=${Date.now()}-${++esmBustSeq}` : baseUrl;
      mod = await import(spec);
    } else {
      if (bustCache) invalidatePluginModuleCache(pkgDir);
      try {
        mod = require(prep.realEntry);
      } catch (err: any) {
        if (err?.code === "ERR_REQUIRE_ESM" || err?.code === "ERR_REQUIRE_ASYNC_MODULE") {
          const baseUrl = pathToFileURL(prep.realEntry).href;
          const spec = bustCache ? `${baseUrl}?wt=${Date.now()}-${++esmBustSeq}` : baseUrl;
          mod = await import(spec);
        } else {
          throw err;
        }
      }
    }

    return hydrateLoadedPlugin(mod, prep.manifest, prep.pkg, pkgDir);
  } catch (e: any) {
    console.error(`[Weavetab] Failed loading plugin at ${pkgDir}:`, e?.message || e);
    return null;
  }
}

export function discoverPlugins(pluginDir?: string): WeavetabPlugin[] {
  const plugins: WeavetabPlugin[] = [];
  const seenPluginNames = new Set<string>();
  const disabled = getDisabledPlugins();

  const candidates = pluginDir
    ? scanNodeModulesPluginDirs(pluginDir)
    : [...getWorkspacePluginDirs(), ...scanNodeModulesPluginDirs()];

  for (const pdir of candidates) {
    const info = inspectInstalledPackage(pdir);
    if (!info || disabled.has(info.packageName) || seenPluginNames.has(info.packageName)) continue;
    const plugin = tryLoadPlugin(pdir);
    if (plugin && !seenPluginNames.has(plugin.name)) {
      seenPluginNames.add(plugin.name);
      plugins.push(plugin);
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

export function resolveInstalledPluginInfo(query: string, pluginDir?: string): InstalledPluginInfo | null {
  const installed = listInstalledPlugins(pluginDir);
  return installed.find((p) => matchesPluginQuery(p, query)) || null;
}

export async function loadAndInitPlugin(
  query: string,
  pluginDir?: string
): Promise<{ plugin: WeavetabPlugin; info: InstalledPluginInfo } | null> {
  const info = resolveInstalledPluginInfo(query, pluginDir);
  if (!info) return null;
  const plugin = await tryLoadPluginAsync(info.dir, true);
  if (!plugin) return null;
  if (typeof plugin.onLoad === "function") {
    const ctx = (plugin as any)._context;
    await plugin.onLoad(ctx);
  }
  return { plugin, info };
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
  const pluginBlocks: string[] = [];

  for (const pl of plugins) {
    const cmds = getPluginCommands(pl);
    const text = pl.instructions?.trim();
    if (!text && cmds.length === 0) continue;

    const lines: string[] = [`### ${pl.name} (v${pl.version || "1.0.0"})`];
    if (text) {
      lines.push(text);
    }
    if (cmds.length > 0) {
      lines.push(
        "**CLI Commands** (run via terminal execution):",
        ...cmds.map((c) => `- \`${c.usage}\` — ${c.description}`)
      );
    }
    pluginBlocks.push(lines.join("\n"));
  }

  if (pluginBlocks.length === 0) return "";

  return "## Active Weavetab Plugins\n\n" + pluginBlocks.join("\n\n");
}
