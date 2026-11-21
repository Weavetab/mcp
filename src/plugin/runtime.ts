/**
 * src/plugin/runtime.ts — Zero-restart dynamic hot-swap & lifecycle manager
 *
 * Manages plugin lifecycle: baseline snapshotting, dynamic tool registration tracking,
 * built-in tool override & removal restoration, hook pipeline unmounting, surface cleanup,
 * require.cache invalidation, and MCP notification broadcasting.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../config/loader.js";
import type { WeavetabPlugin, WeavetabToolOverride } from "./interface.js";
import { hookPipeline } from "./pipeline.js";
import { createSurface } from "./surface.js";
import { toPluginInputShape } from "./schema.js";
import {
  tryLoadPluginAsync,
  resolvePluginEntry,
  getDisabledPlugins,
  buildPluginInstructions,
  invalidatePluginModuleCache,
  listInstalledPlugins,
  type InstalledPluginInfo,
} from "./loader.js";
import { resolvePluginTrust } from "./registry.js";

export interface PluginRuntimeCallbacks {
  withSecurity: (
    config: Config,
    toolName: string,
    fn: (session: any, liveConfig: Config) => Promise<any>,
    isOfficial?: boolean,
    targetApp?: string,
    requiresSession?: boolean
  ) => Promise<any>;
  createTabProxy: (session: any) => any;
  normalizeToolResult: (result: any) => any;
  wrapError: (err: any) => any;
}

export interface PluginRegistrationRecord {
  name: string;
  pkgDir: string;
  version: string;
  entryMtime: number;
  plugin: WeavetabPlugin;
  staticTools: Set<string>;
  dynamicTools: Set<string>;
  overrides: Set<string>;
  removals: Set<string>;
  disposables: Array<() => void>;
}

export class PluginRuntime {
  private server: McpServer;
  private config: Config;
  private surface: ReturnType<typeof createSurface>;
  private verifiedPackages: Set<string>;
  private callbacks: PluginRuntimeCallbacks;

  private builtInBaseline = new Map<string, any>();
  private records = new Map<string, PluginRegistrationRecord>();
  private watchers: fs.FSWatcher[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private isSyncing = false;

  constructor(opts: {
    server: McpServer;
    config: Config;
    surface: ReturnType<typeof createSurface>;
    verifiedPackages: Set<string>;
    callbacks: PluginRuntimeCallbacks;
  }) {
    this.server = opts.server;
    this.config = opts.config;
    this.surface = opts.surface;
    this.verifiedPackages = opts.verifiedPackages;
    this.callbacks = opts.callbacks;
  }

  /**
   * Freezes the baseline of all built-in tools before plugins mount overrides or removals.
   */
  snapshotBaseline(): void {
    const current = (this.server as any)._registeredTools || {};
    this.builtInBaseline.clear();
    for (const [name, def] of Object.entries(current)) {
      this.builtInBaseline.set(name, def);
    }
  }

  getActivePlugins(): WeavetabPlugin[] {
    return Array.from(this.records.values()).map((r) => r.plugin);
  }

  getRecord(name: string): PluginRegistrationRecord | undefined {
    return this.records.get(name);
  }

  private getEntryMtime(pkgDir: string, plugin: WeavetabPlugin): number {
    let latest = 0;
    try {
      let pkg: Record<string, any> | undefined;
      const pkgPath = path.resolve(pkgDir, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
        } catch {}
      }
      const realEntry = resolvePluginEntry(pkgDir, plugin.manifest, pkg);
      if (realEntry && fs.existsSync(realEntry)) {
        latest = Math.max(latest, fs.statSync(realEntry).mtimeMs);
      }
      const manifestPath = path.resolve(pkgDir, "weavetab.json");
      if (fs.existsSync(manifestPath)) {
        latest = Math.max(latest, fs.statSync(manifestPath).mtimeMs);
      }
    } catch {
      // fallback
    }
    return latest || Date.now();
  }

  private mountTool(plugin: WeavetabPlugin, isOfficial: boolean, td: any): void {
    if ((this.server as any)._registeredTools?.[td.name]) {
      delete (this.server as any)._registeredTools[td.name];
    }

    const pluginCtx = (plugin as any)._context;
    this.server.tool(
      td.name,
      td.description || "",
      toPluginInputShape(td.schema || td.inputSchema || td.parameters),
      async (args: any) => {
        try {
          return await this.callbacks.withSecurity(
            this.config,
            td.name,
            async (session, liveConfig) => {
              const tab = this.callbacks.createTabProxy(session);
              const toolCtx = {
                tab,
                desktop: pluginCtx?.desktop,
                storage: plugin.storage,
                extension: pluginCtx?.extension || plugin.extension,
                memory: pluginCtx?.memory,
                config: pluginCtx?.config ?? {},
                serverConfig: liveConfig,
                logger: pluginCtx?.logger,
                session,
              };
              const callCtx = session ? Object.assign(Object.create(session), toolCtx) : toolCtx;
              const res =
                td.handler.length <= 2
                  ? await td.handler(args, callCtx)
                  : await td.handler(args, session, liveConfig);
              return this.callbacks.normalizeToolResult(res);
            },
            isOfficial,
            undefined,
            td.requiresSession !== false
          );
        } catch (e) {
          return this.callbacks.wrapError(e);
        }
      }
    );
  }

  private mountToolOverride(
    pluginName: string,
    isOfficial: boolean,
    ov: WeavetabToolOverride,
    record: PluginRegistrationRecord
  ): void {
    const existingTool = (this.server as any)._registeredTools?.[ov.name] || this.builtInBaseline.get(ov.name);
    const existingDesc = existingTool?.description || "";
    const existingSchema = existingTool?.inputSchema?.shape || existingTool?.parameters?.shape || {};
    const rawExistingFn = existingTool?._rawHandler || existingTool?.handler || existingTool?.callback;

    if ((this.server as any)._registeredTools?.[ov.name]) {
      delete (this.server as any)._registeredTools[ov.name];
    }

    const rawOverrideFn = async (args: any, session: any, liveConfig: Config) => {
      const wrappedOrig = rawExistingFn
        ? async (origArgs: Record<string, any>, origSess?: any, origCfg?: any) => {
            const finalSess = origSess || session;
            const finalCfg = origCfg || liveConfig;
            return await rawExistingFn(origArgs, finalSess, finalCfg);
          }
        : undefined;
      const rawRes = await ov.handler(args, session, liveConfig, wrappedOrig);
      return this.callbacks.normalizeToolResult(rawRes);
    };

    this.server.tool(
      ov.name,
      ov.description || existingDesc || `Tool overridden by ${pluginName}`,
      ov.schema ? toPluginInputShape(ov.schema) : existingSchema,
      async (args: any) => {
        try {
          return await this.callbacks.withSecurity(
            this.config,
            ov.name,
            async (session, liveConfig) => {
              return await rawOverrideFn(args, session, liveConfig);
            },
            isOfficial
          );
        } catch (e) {
          return this.callbacks.wrapError(e);
        }
      }
    );

    if ((this.server as any)._registeredTools?.[ov.name]) {
      (this.server as any)._registeredTools[ov.name]._rawHandler = rawOverrideFn;
    }
    record.overrides.add(ov.name);
  }

  /**
   * Completely unloads a plugin, clearing tools, hooks, utilities, and restoring built-in tools.
   */
  async unloadPlugin(pluginName: string): Promise<boolean> {
    const rec = this.records.get(pluginName);
    if (!rec) return false;

    process.stderr.write(`[Weavetab] Unloading plugin: ${pluginName}\n`);

    // 1. Run plugin onUnload with 3-second timeout protection
    if (typeof rec.plugin.onUnload === "function") {
      try {
        await Promise.race([
          Promise.resolve(rec.plugin.onUnload((rec.plugin as any)._context)),
          new Promise((_, reject) => setTimeout(() => reject(new Error("onUnload timeout (3s)")), 3000)),
        ]);
      } catch (err: any) {
        process.stderr.write(`[Weavetab] Error in plugin "${pluginName}" onUnload: ${err?.message || err}\n`);
      }
    }

    // 2. Unregister all hooks from central pipeline
    hookPipeline.unregisterPluginHooks(pluginName);

    // 3. Remove all registered tools (both static and dynamic)
    const allRegisteredTools = new Set([...rec.staticTools, ...rec.dynamicTools]);
    for (const toolName of allRegisteredTools) {
      if ((this.server as any)._registeredTools?.[toolName]) {
        delete (this.server as any)._registeredTools[toolName];
      }
    }

    // 4. Drop prompts and resources from surface
    this.surface.dropAll(pluginName);

    // 5. Execute all disposables (e.g. core instructions resources)
    for (const dispose of rec.disposables) {
      try {
        dispose();
      } catch {
        // ignore
      }
    }
    rec.disposables = [];

    // 6. Restore built-in tools from baseline for any tool this plugin modified
    for (const toolName of [...rec.overrides, ...rec.removals]) {
      const origDef = this.builtInBaseline.get(toolName);
      if (origDef) {
        (this.server as any)._registeredTools[toolName] = origDef;
      }
    }

    // 7. Purge Node module require cache for this package directory
    invalidatePluginModuleCache(rec.pkgDir);

    this.records.delete(pluginName);

    // 8. If other active plugins still override any restored tools, reapply them
    this.reapplyActiveOverrides();

    return true;
  }

  async loadPlugin(pkgDir: string): Promise<boolean> {
    const plugin = await tryLoadPluginAsync(pkgDir, true);
    if (!plugin) return false;

    if (this.records.has(plugin.name)) {
      await this.unloadPlugin(plugin.name);
    }

    const trust = resolvePluginTrust(plugin.name, this.verifiedPackages, pkgDir);
    const isOfficial = trust.tier === "official";
    const manifestPerms = plugin.manifest?.permissions;

    const record: PluginRegistrationRecord = {
      name: plugin.name,
      pkgDir,
      version: plugin.version || "1.0.0",
      entryMtime: this.getEntryMtime(pkgDir, plugin),
      plugin,
      staticTools: new Set(),
      dynamicTools: new Set(),
      overrides: new Set(),
      removals: new Set(),
      disposables: [],
    };

    // 1. Register lifecycle hooks declared on plugin object
    if (plugin.hooks) {
      hookPipeline.registerPluginHooks(plugin.name, plugin.hooks);
    }

    // 2. Built-in Tool Removals
    const declaredRemove: string[] = Array.isArray(manifestPerms) ? [] : manifestPerms?.tools?.remove || [];
    for (const toolName of plugin.removeTools || []) {
      if (!declaredRemove.includes(toolName)) {
        process.stderr.write(
          `  \x1b[33m[!] Plugin ${plugin.name} tried to remove "${toolName}" without permissions.tools.remove — skipped.\x1b[0m\n`
        );
        continue;
      }
      if ((this.server as any)._registeredTools?.[toolName]) {
        delete (this.server as any)._registeredTools[toolName];
        record.removals.add(toolName);
      }
    }

    // 3. Built-in Tool Overrides
    const declaredOverride: string[] = Array.isArray(manifestPerms) ? [] : manifestPerms?.tools?.override || [];
    for (const ov of plugin.overrides || []) {
      if (!declaredOverride.includes(ov.name)) {
        process.stderr.write(
          `  \x1b[33m[!] Plugin ${plugin.name} tried to override "${ov.name}" without permissions.tools.override — skipped.\x1b[0m\n`
        );
        continue;
      }
      this.mountToolOverride(plugin.name, isOfficial, ov, record);
    }

    // 4. Static Tool Additions
    const canAddTools = !Array.isArray(manifestPerms) && manifestPerms?.tools?.add === true;
    for (const td of plugin.tools || []) {
      if (!canAddTools) {
        process.stderr.write(
          `  \x1b[33m[!] Plugin ${plugin.name} tried to add tool "${td.name}" without permissions.tools.add — skipped.\x1b[0m\n`
        );
        continue;
      }
      if (this.builtInBaseline.has(td.name)) {
        process.stderr.write(
          `  \x1b[33m[!] Plugin ${plugin.name} tried to overwrite built-in tool "${td.name}" via tools.add — use tools.override instead.\x1b[0m\n`
        );
        continue;
      }
      this.mountTool(plugin, isOfficial, td);
      record.staticTools.add(td.name);
    }

    // 5. Utilities (/ Prompts and @ Resources)
    const canPrompt = !Array.isArray(manifestPerms) && manifestPerms?.prompts?.add === true;
    const canResource = !Array.isArray(manifestPerms) && manifestPerms?.resources?.add === true;

    for (const pd of plugin.prompts || []) {
      if (!canPrompt) {
        process.stderr.write(
          `  \x1b[33m[!] Plugin ${plugin.name} tried to add prompt "${pd.name}" without permissions.prompts.add — skipped.\x1b[0m\n`
        );
        continue;
      }
      this.surface.addPrompt(plugin.name, pd);
    }
    for (const rd of plugin.resources || []) {
      if (!canResource) {
        process.stderr.write(
          `  \x1b[33m[!] Plugin ${plugin.name} tried to add resource "${rd.name}" without permissions.resources.add — skipped.\x1b[0m\n`
        );
        continue;
      }
      this.surface.addResource(plugin.name, rd);
    }

    // 6. Intercept context mcp APIs to track dynamic registrations
    const fullPluginCtx = (plugin as any)._context;
    if (fullPluginCtx && fullPluginCtx.mcp) {
      fullPluginCtx.mcp.registerTool = (tool: any) => {
        if (!canAddTools) {
          process.stderr.write(
            `  \x1b[33m[!] Plugin ${plugin.name} tried to register tool "${tool?.name}" without permissions.tools.add — skipped.\x1b[0m\n`
          );
          return;
        }
        if (!tool?.name || typeof tool.handler !== "function") return;
        if (this.builtInBaseline.has(tool.name)) {
          process.stderr.write(
            `  \x1b[33m[!] Plugin ${plugin.name} tried to overwrite built-in tool "${tool.name}" via registerTool — use overrideTool instead.\x1b[0m\n`
          );
          return;
        }
        this.mountTool(plugin, isOfficial, tool);
        record.dynamicTools.add(tool.name);
      };

      fullPluginCtx.mcp.overrideTool = (toolName: string, overrideHandler: any) => {
        if (!declaredOverride.includes(toolName)) {
          process.stderr.write(
            `  \x1b[33m[!] Plugin ${plugin.name} tried to override "${toolName}" without permissions.tools.override — skipped.\x1b[0m\n`
          );
          return;
        }
        const ov: WeavetabToolOverride =
          typeof overrideHandler === "function"
            ? { name: toolName, handler: overrideHandler }
            : { ...overrideHandler, name: toolName };
        plugin.overrides = plugin.overrides || [];
        const idx = plugin.overrides.findIndex((o) => o.name === toolName);
        if (idx >= 0) plugin.overrides[idx] = ov;
        else plugin.overrides.push(ov);
        this.mountToolOverride(plugin.name, isOfficial, ov, record);
      };

      fullPluginCtx.mcp.registerPrompt = (prompt: any) => {
        if (!canPrompt) {
          process.stderr.write(
            `  \x1b[33m[!] Plugin ${plugin.name} tried to register prompt "${prompt?.name}" without permissions.prompts.add — skipped.\x1b[0m\n`
          );
          return;
        }
        this.surface.addPrompt(plugin.name, prompt);
      };
      fullPluginCtx.mcp.registerResource = (resource: any) => {
        if (!canResource) {
          process.stderr.write(
            `  \x1b[33m[!] Plugin ${plugin.name} tried to register resource "${resource?.name}" without permissions.resources.add — skipped.\x1b[0m\n`
          );
          return;
        }
        this.surface.addResource(plugin.name, resource);
      };
      fullPluginCtx.mcp.unregisterPrompt = (pname: string) => {
        this.surface.removePrompt(plugin.name, pname);
      };
      fullPluginCtx.mcp.unregisterResource = (rkey: string) => {
        this.surface.removeResource(plugin.name, rkey);
      };
      fullPluginCtx.mcp.removeTool = (tname: string) => {
        if (!declaredRemove.includes(tname) && !record.staticTools.has(tname) && !record.dynamicTools.has(tname)) {
          process.stderr.write(
            `  \x1b[33m[!] Plugin ${plugin.name} tried to remove "${tname}" without permissions.tools.remove — skipped.\x1b[0m\n`
          );
          return;
        }
        if ((this.server as any)._registeredTools?.[tname]) {
          delete (this.server as any)._registeredTools[tname];
          if (this.builtInBaseline.has(tname)) {
            record.removals.add(tname);
          } else {
            record.staticTools.delete(tname);
            record.dynamicTools.delete(tname);
          }
        }
      };
      fullPluginCtx.mcp.unregisterTool = fullPluginCtx.mcp.removeTool;
    }

    // 7. Register dedicated instructions resource
    const instructionsText = plugin.instructions;
    if (instructionsText) {
      try {
        const uri = `weavetab://plugins/${plugin.name}/instructions`;
        const h = this.server.registerResource(
          `${plugin.name} Instructions`,
          uri,
          { mimeType: "text/markdown", description: `Agent instructions for ${plugin.name}` },
          async () => ({
            contents: [
              {
                uri,
                mimeType: "text/markdown",
                text: plugin.instructions || "",
              },
            ],
          })
        );
        record.disposables.push(() => {
          try {
            if (h && typeof (h as any).remove === "function") (h as any).remove();
            else delete (this.server as any)._registeredResources?.[uri];
          } catch {}
        });
      } catch {
        // resource collision handled
      }
    }

    // 8. Execute plugin onLoad
    if (typeof plugin.onLoad === "function") {
      try {
        await plugin.onLoad(fullPluginCtx || (plugin as any)._context);
        if (plugin.hooks) {
          hookPipeline.unregisterPluginHooks(plugin.name);
          hookPipeline.registerPluginHooks(plugin.name, plugin.hooks);
        }
      } catch (err: any) {
        process.stderr.write(`  \u001b[31m[!] Plugin ${plugin.name} onLoad failed: ${err?.message}\u001b[0m\n`);
      }
    }

    this.records.set(plugin.name, record);
    process.stderr.write(`  [Plugin Loaded] ${plugin.name} v${plugin.version}\n`);
    return true;
  }

  private reapplyActiveOverrides(): void {
    for (const rec of this.records.values()) {
      const isOfficial = resolvePluginTrust(rec.name, this.verifiedPackages, rec.pkgDir).tier === "official";
      for (const toolName of rec.removals) {
        if ((this.server as any)._registeredTools?.[toolName]) {
          delete (this.server as any)._registeredTools[toolName];
        }
      }
      for (const ov of rec.plugin.overrides || []) {
        if (rec.overrides.has(ov.name)) {
          this.mountToolOverride(rec.name, isOfficial, ov, rec);
        }
      }
    }
  }

  /**
   * Discovers plugins across workspace and global directories, diffs with live records,
   * unloads stale plugins, hot-reloads updated plugins, and loads new plugins.
   */
  async sync(): Promise<boolean> {
    if (this.isSyncing) return false;
    this.isSyncing = true;

    try {
      const disabled = getDisabledPlugins();
      const installed = listInstalledPlugins();
      const onDiskMap = new Map<string, InstalledPluginInfo>();
      for (const info of installed) {
        if (!disabled.has(info.packageName)) {
          onDiskMap.set(info.packageName, info);
        }
      }

      let changes = 0;

      // 1. Unload deleted plugins
      for (const [name, rec] of Array.from(this.records.entries())) {
        if (!onDiskMap.has(name)) {
          await this.unloadPlugin(name);
          changes++;
        }
      }

      // 2. Detect updated or new plugins
      for (const [name, info] of onDiskMap.entries()) {
        const existing = this.records.get(name);
        if (!existing) {
          const ok = await this.loadPlugin(info.dir);
          if (ok) changes++;
        } else {
          // Check if updated on disk (package.json is the primary version source)
          const latestMtime = this.getEntryMtime(info.dir, existing.plugin);
          const diskVersion = info.pkgJson?.version || info.manifest?.version || "1.0.0";
          const versionChanged = existing.version !== diskVersion;
          if (versionChanged || latestMtime > existing.entryMtime) {
            process.stderr.write(`[Weavetab] Plugin "${name}" updated on disk — hot-reloading...\n`);
            await this.unloadPlugin(name);
            const ok = await this.loadPlugin(info.dir);
            if (ok) changes++;
          }
        }
      }

      if (changes > 0) {
        this.updateInstructionsAndBroadcast();
        process.stderr.write(`[Weavetab] Hot-swap complete: ${this.records.size} active plugin(s) (${changes} change(s))\n`);
        return true;
      }
    } catch (err: any) {
      process.stderr.write(`[Weavetab] Hot-swap sync error: ${err?.message || err}\n`);
    } finally {
      this.isSyncing = false;
    }
    return false;
  }

  updateInstructionsAndBroadcast(): void {
    const text = buildPluginInstructions(this.getActivePlugins());
    if ((this.server as any).server) {
      (this.server as any).server._instructions = text;
      Promise.resolve((this.server as any).server.sendToolListChanged?.()).catch(() => {});
      Promise.resolve((this.server as any).server.sendPromptListChanged?.()).catch(() => {});
      Promise.resolve((this.server as any).server.sendResourceListChanged?.()).catch(() => {});
    }
  }

  /**
   * Starts monitoring for changes.
   */
  startWatchers(): void {
    this.stopWatchers();

    const triggerDebounced = () => {
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        this.sync().catch(() => {});
      }, 250);
      this.debounceTimer.unref?.();
    };

    // 1. Global plugins directory watcher (watches ~/.weavetab/plugins)
    try {
      const globalDir = path.join(os.homedir(), ".weavetab", "plugins");
      if (!fs.existsSync(globalDir)) {
        fs.mkdirSync(globalDir, { recursive: true });
      }
      const w1 = fs.watch(globalDir, { recursive: false }, (_evt, filename) => {
        if (!filename || filename === ".epoch" || filename === "package.json") {
          triggerDebounced();
        }
      });
      w1.on("error", () => {});
      (w1 as any).unref?.();
      this.watchers.push(w1);
    } catch {
      // ignore watcher failure on restricted systems
    }

    // 2. Workspace plugins directory watcher (only when explicitly opted in)
    if (process.env.WT_ALLOW_WORKSPACE_PLUGINS === "1") {
      try {
        const wsPlugins = path.resolve(process.cwd(), "plugins");
        if (fs.existsSync(wsPlugins)) {
          const w2 = fs.watch(wsPlugins, { recursive: true }, () => {
            triggerDebounced();
          });
          w2.on("error", () => {});
          (w2 as any).unref?.();
          this.watchers.push(w2);
        }
      } catch {
        // ignore
      }
    }
  }

  stopWatchers(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }
    this.watchers = [];
  }

  async stop(): Promise<void> {
    this.stopWatchers();
    for (const name of Array.from(this.records.keys())) {
      await this.unloadPlugin(name);
    }
    this.records.clear();
    this.builtInBaseline.clear();
  }
}
