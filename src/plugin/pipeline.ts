/**
 * src/plugin/pipeline.ts — Central Hook Dispatch Pipeline for Weavetab Plugins
 *
 * Dispatches lifecycle events:
 * - onBeforeAction / beforeToolCall: Intercept tool calls, modify arguments, or block unauthorized actions
 * - onAfterAction / afterToolCall: Transform, redact, or augment tool return results
 * - onDOMMutation: Stream real-time DOM mutation deltas to registered plugins
 * - onPageNavigate: Notify plugins upon browser navigation
 */

import type { DOMMutationDelta } from "./interface.js";

export type BeforeToolCallHook = (
  toolName: string,
  args: Record<string, any>,
  session?: any
) => Promise<Record<string, any> | { __blocked: boolean; reason?: string } | void> | Record<string, any> | { __blocked: boolean; reason?: string } | void;

export type AfterToolCallHook = (
  toolName: string,
  args: Record<string, any>,
  result: any,
  session?: any
) => Promise<any | void> | any | void;

export type PageNavigateHook = (
  url: string,
  session?: any
) => Promise<void> | void;

export type DOMMutationHook = (
  delta: DOMMutationDelta,
  session?: any
) => Promise<void> | void;

export interface PluginHooksRegistry {
  beforeToolCall?: BeforeToolCallHook[] | BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook[] | AfterToolCallHook;
  onBeforeAction?: BeforeToolCallHook[] | BeforeToolCallHook;
  onAfterAction?: Array<(tool: string, result: any, session?: any, args?: Record<string, any>) => any> | ((tool: string, result: any, session?: any, args?: Record<string, any>) => any);
  onDOMMutation?: DOMMutationHook[] | DOMMutationHook;
  onPageNavigate?: PageNavigateHook[] | PageNavigateHook;
}

class HookPipeline {
  private beforeToolCallHooks: Array<{ pluginName: string; fn: BeforeToolCallHook }> = [];
  private afterToolCallHooks: Array<{ pluginName: string; fn: AfterToolCallHook }> = [];
  private onDOMMutationHooks: Array<{ pluginName: string; fn: DOMMutationHook }> = [];
  private onPageNavigateHooks: Array<{ pluginName: string; fn: PageNavigateHook }> = [];

  /**
   * Register hooks for a specific plugin.
   */
  registerPluginHooks(pluginName: string, hooks: Partial<PluginHooksRegistry> & Record<string, any>): void {
    if (!hooks) return;

    // 1. Before Action / Before Tool Call
    const beforeFns = hooks.onBeforeAction || hooks.beforeToolCall;
    if (beforeFns) {
      const list = Array.isArray(beforeFns) ? beforeFns : [beforeFns];
      for (const fn of list) {
        if (typeof fn === "function") {
          this.beforeToolCallHooks.push({ pluginName, fn });
        }
      }
    }

    // 2. After Action (signature: (tool, result, session, args))
    if (hooks.onAfterAction) {
      const list = Array.isArray(hooks.onAfterAction) ? hooks.onAfterAction : [hooks.onAfterAction];
      for (const fn of list) {
        if (typeof fn === "function") {
          this.afterToolCallHooks.push({
            pluginName,
            fn: async (toolName, args, result, session) => {
              return await fn(toolName, result, session, args);
            },
          });
        }
      }
    }

    // Legacy After Tool Call (signature: (tool, args, result, session))
    if (hooks.afterToolCall) {
      const list = Array.isArray(hooks.afterToolCall) ? hooks.afterToolCall : [hooks.afterToolCall];
      for (const fn of list) {
        if (typeof fn === "function") {
          this.afterToolCallHooks.push({ pluginName, fn });
        }
      }
    }

    // 3. DOM Mutation Hooks
    if (hooks.onDOMMutation) {
      const list = Array.isArray(hooks.onDOMMutation) ? hooks.onDOMMutation : [hooks.onDOMMutation];
      for (const fn of list) {
        if (typeof fn === "function") {
          this.onDOMMutationHooks.push({ pluginName, fn });
        }
      }
    }

    // 4. Page Navigate Hooks
    if (hooks.onPageNavigate) {
      const list = Array.isArray(hooks.onPageNavigate) ? hooks.onPageNavigate : [hooks.onPageNavigate];
      for (const fn of list) {
        if (typeof fn === "function") {
          this.onPageNavigateHooks.push({ pluginName, fn });
        }
      }
    }
  }

  /**
   * Remove all hooks registered by a plugin on unload.
   */
  unregisterPluginHooks(pluginName: string): void {
    this.beforeToolCallHooks = this.beforeToolCallHooks.filter((h) => h.pluginName !== pluginName);
    this.afterToolCallHooks = this.afterToolCallHooks.filter((h) => h.pluginName !== pluginName);
    this.onDOMMutationHooks = this.onDOMMutationHooks.filter((h) => h.pluginName !== pluginName);
    this.onPageNavigateHooks = this.onPageNavigateHooks.filter((h) => h.pluginName !== pluginName);
  }

  /**
   * Dispatches beforeAction / beforeToolCall hooks in sequence.
   * If a hook returns an object, arguments are augmented/modified.
   * If a hook returns { __blocked: true, reason } or throws, execution is aborted.
   */
  async dispatchBeforeToolCall(
    toolName: string,
    args: Record<string, any>,
    session?: any
  ): Promise<Record<string, any>> {
    let currentArgs = { ...args };
    for (const { pluginName, fn } of this.beforeToolCallHooks) {
      try {
        const modified = await fn(toolName, currentArgs, session);
        if (modified && typeof modified === "object") {
          if ((modified as any).__blocked) {
            const reason = (modified as any).reason || `Action '${toolName}' blocked by plugin '${pluginName}'`;
            const blockError = new Error(reason);
            (blockError as any).isBlocked = true;
            (blockError as any).pluginName = pluginName;
            throw blockError;
          }
          if (!Array.isArray(modified)) {
            currentArgs = { ...currentArgs, ...modified };
          }
        }
      } catch (err: any) {
        if (err?.isBlocked) {
          throw err;
        }
        process.stderr.write(
          `[Weavetab Hooks] Error in beforeToolCall (${pluginName} on ${toolName}): ${err?.message || err}\n`
        );
      }
    }
    return currentArgs;
  }

  /**
   * Alias for dispatchBeforeToolCall.
   */
  async dispatchBeforeAction(
    toolName: string,
    args: Record<string, any>,
    session?: any
  ): Promise<Record<string, any>> {
    return this.dispatchBeforeToolCall(toolName, args, session);
  }

  /**
   * Dispatches afterAction / afterToolCall hooks in sequence.
   * Allows plugins to inspect, transform, or redact tool results.
   */
  async dispatchAfterToolCall(
    toolName: string,
    args: Record<string, any>,
    result: any,
    session?: any
  ): Promise<any> {
    let currentResult = result;
    for (const { pluginName, fn } of this.afterToolCallHooks) {
      try {
        const modified = await fn(toolName, args, currentResult, session);
        if (modified !== undefined) {
          currentResult = modified;
        }
      } catch (err: any) {
        process.stderr.write(
          `[Weavetab Hooks] Error in afterToolCall (${pluginName} on ${toolName}): ${err?.message || err}\n`
        );
      }
    }
    return currentResult;
  }

  /**
   * Alias for dispatchAfterToolCall.
   */
  async dispatchAfterAction(
    toolName: string,
    result: any,
    session?: any,
    args?: Record<string, any>
  ): Promise<any> {
    return this.dispatchAfterToolCall(toolName, args || {}, result, session);
  }

  /**
   * Dispatches DOM mutation deltas to all listening plugins.
   */
  async dispatchDOMMutation(delta: DOMMutationDelta, session?: any): Promise<void> {
    if (this.onDOMMutationHooks.length === 0) return;
    for (const { pluginName, fn } of this.onDOMMutationHooks) {
      try {
        await fn(delta, session);
      } catch (err: any) {
        process.stderr.write(
          `[Weavetab Hooks] Error in onDOMMutation (${pluginName}): ${err?.message || err}\n`
        );
      }
    }
  }

  /**
   * Dispatches onPageNavigate hooks when navigation occurs.
   */
  async dispatchPageNavigate(url: string, session?: any): Promise<void> {
    for (const { pluginName, fn } of this.onPageNavigateHooks) {
      try {
        await fn(url, session);
      } catch (err: any) {
        process.stderr.write(
          `[Weavetab Hooks] Error in onPageNavigate (${pluginName}): ${err?.message || err}\n`
        );
      }
    }
  }

  /**
   * Clears all registered hooks.
   */
  clearAllHooks(): void {
    this.beforeToolCallHooks = [];
    this.afterToolCallHooks = [];
    this.onDOMMutationHooks = [];
    this.onPageNavigateHooks = [];
  }
}

export const hookPipeline = new HookPipeline();
