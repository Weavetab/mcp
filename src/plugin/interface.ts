import type { z } from "zod";
import type CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import type { IPluginStorage } from "./storage.js";
import type { IPluginExtensionBridge } from "./extension_bridge.js";

export interface WeavetabToolDefinition {
  name: string;
  description: string;
  schema: Record<string, z.ZodType<any>>;
  handler: (args: Record<string, any>, session: CDP.Client, config: Config) => Promise<Record<string, any>>;
}

export interface WeavetabToolOverride {
  /** The name of the built-in tool to override / wrap (e.g. "browser_eval") */
  name: string;
  /** Optional new description (defaults to existing description if omitted) */
  description?: string;
  /** Optional new schema (defaults to existing schema if omitted) */
  schema?: Record<string, z.ZodType<any>>;
  /**
   * New handler. Can optionally call `originalHandler` to wrap or augment behavior.
   */
  handler: (
    args: Record<string, any>,
    session: CDP.Client,
    config: Config,
    originalHandler?: (args: Record<string, any>, session: CDP.Client, config: Config) => Promise<any>
  ) => Promise<Record<string, any>>;
}

export interface WeavetabManifestTool {
  name: string;
  description: string;
  inputSchema?: Record<string, any>;
  parameters?: Record<string, any>;
}

export interface WeavetabPermissions {
  config?: {
    read?: boolean;
    write?: boolean;
    default?: Record<string, any>;
    reason?: string;
  };
  extension?: {
    hud?: boolean;
    overlay?: boolean;
    styles?: boolean;
    scripts?: boolean;
    reason?: string;
  };
  network?: {
    domains?: string[];
    hosts?: string[];
    intercept?: boolean;
    reason?: string;
  };
  cdp?: {
    evaluate?: boolean;
    navigate?: boolean;
    click?: boolean;
    input?: boolean;
    screenshot?: boolean;
    dom?: boolean;
    reason?: string;
    [key: string]: any;
  };
  fs?: {
    read?: string[];
    write?: string[];
    reason?: string;
  };
  filesystem?: {
    read?: string[];
    write?: string[];
    reason?: string;
  };
  tools?: {
    /** List of built-in tool names this plugin is permitted to override */
    override?: string[];
    /** List of built-in tool names this plugin is permitted to remove */
    remove?: string[];
    hooks?: boolean;
    reason?: string;
  };
  [key: string]: any;
}

export type WeavetabManifestPermissions = WeavetabPermissions | string[];

export interface WeavetabManifestAuthor {
  name: string;
  role?: string;
  avatar?: string;
  url?: string;
  email?: string;
}

export interface WeavetabManifestLinks {
  github?: string;
  npm?: string;
  docs?: string;
  issues?: string;
  homepage?: string;
}

export interface WeavetabManifest {
  /** Schema identifier */
  $schema?: string;
  /** Human-readable display name */
  name: string;
  /** Semantic version string */
  version: string;
  /** Short summary of what this plugin provides */
  description?: string;
  /** Entry point file relative to the plugin root (e.g., 'dist/index.js') */
  entry?: string;
  /** Single author or multiple authors with roles */
  author?: string | WeavetabManifestAuthor | (string | WeavetabManifestAuthor)[];
  /** Array of authors */
  authors?: (string | WeavetabManifestAuthor)[];
  /** Path to plugin logo */
  logo?: string;
  /** Path to plugin header banner */
  banner?: string;
  /** Path to README markdown file (default: "README.md") */
  readme?: string;
  /** Category tags */
  tags?: string[];
  /** External links */
  links?: WeavetabManifestLinks;
  /** Engine dependencies */
  engines?: Record<string, string>;
  /** Supported environments */
  environments?: string[];
  /** Whether the plugin should be lazy-loaded on demand */
  lazy?: boolean;
  /** Tools exposed by this plugin to the MCP server */
  tools?: WeavetabManifestTool[];
  /** Default configuration template */
  defaultConfig?: Record<string, any>;
  /** Required permissions with security rationale */
  permissions?: WeavetabManifestPermissions;
  /** Open source license */
  license?: string;
  [key: string]: any;
}

export interface WeavetabPluginTool<TArgs = any> {
  name: string;
  description: string;
  schema?: Record<string, any> | Record<string, z.ZodType<any>>;
  inputSchema?: Record<string, any>;
  parameters?: Record<string, any>;
  handler: (args: TArgs, session?: any, config?: any) => Promise<any>;
}

export interface DOMMutationDelta {
  type?: "cdp_mutation" | "action_delta" | "page_update" | "dom_diff" | "rich_delta" | string;
  timestamp?: number;
  url?: string;
  added?: Array<{
    id?: string;
    role?: string;
    label?: string;
    tag?: string;
    text?: string;
    backendNodeId?: number;
    [key: string]: any;
  }>;
  removed?: Array<string | { backendNodeId?: number; tag?: string; text?: string; [key: string]: any }>;
  changed?: Array<{
    ref?: string;
    role?: string;
    label?: string;
    attribute?: string;
    oldValue?: any;
    newValue?: any;
    changes?: Record<string, { from: any; to: any }>;
    actionable?: boolean;
    [key: string]: any;
  }>;
  significantChange?: boolean;
  stable_count?: number;
  iframes?: any[];
  [key: string]: any;
}

export type BeforeActionHook = (
  tool: string,
  args: Record<string, any>,
  session?: any
) => Promise<Record<string, any> | { __blocked: boolean; reason?: string } | void> | Record<string, any> | { __blocked: boolean; reason?: string } | void;

export type AfterActionHook = (
  tool: string,
  result: any,
  session?: any,
  args?: Record<string, any>
) => Promise<any> | any;

export type DOMMutationHook = (
  delta: DOMMutationDelta,
  session?: any
) => Promise<void> | void;

export interface PluginHooksContext {
  onBeforeAction: (handler: BeforeActionHook) => void;
  onAfterAction: (handler: AfterActionHook) => void;
  onDOMMutation: (handler: DOMMutationHook) => void;
  beforeToolCall: (handler: (toolName: string, args: Record<string, any>, session?: any) => Promise<any> | void) => void;
  afterToolCall: (handler: (toolName: string, args: Record<string, any>, result: any, session?: any) => Promise<any> | void) => void;
  onPageNavigate?: (handler: (url: string, session?: any) => Promise<void> | void) => void;
}

export interface PluginMcpContext {
  registerTool: (tool: WeavetabPluginTool | any) => void;
  overrideTool?: (toolName: string, overrideHandler: any) => void;
  removeTool?: (toolName: string) => void;
  unregisterTool?: (toolName: string) => void;
  [key: string]: any;
}

export interface PluginMemoryContext {
  getSiteProfile(origin: string): Promise<any>;
  learnPattern(origin: string, name: string, pattern: any): Promise<any>;
  recordExecution(origin: string, name: string, success: boolean, durationMs?: number): Promise<any>;
  getReliability(origin: string, patternName: string): Promise<number>;
  recordQuirk(origin: string, quirkKey: string, quirkData: any): Promise<void>;
}

export interface PluginContext {
  name: string;
  version?: string;
  pluginDir: string;
  config: Record<string, any>;
  storage: IPluginStorage;
  extension: IPluginExtensionBridge;
  mcp: PluginMcpContext;
  hooks: PluginHooksContext;
  memory?: PluginMemoryContext;
  logger: {
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
    debug: (...args: any[]) => void;
  };
  [key: string]: any;
}

export interface WeavetabPluginDefinition {
  name: string;
  version?: string;
  description?: string;
  tools?: WeavetabPluginTool[];
  overrides?: WeavetabToolOverride[];
  removeTools?: string[];
  defaultConfig?: Record<string, any>;
  onBeforeAction?: BeforeActionHook;
  onAfterAction?: AfterActionHook;
  onDOMMutation?: DOMMutationHook;
  onLoad?: (ctx: PluginContext) => Promise<void> | void;
  onUnload?: (ctx: PluginContext) => Promise<void> | void;
}

export interface WeavetabPlugin {
  name: string;
  version: string;
  description?: string;
  /** Add new tools */
  tools?: WeavetabToolDefinition[] | WeavetabPluginTool[];
  /** Override or wrap existing tools */
  overrides?: WeavetabToolOverride[];
  /** Built-in tools to remove or disable */
  removeTools?: string[];
  defaultConfig?: Record<string, any>;
  manifest?: WeavetabManifest;
  storage?: IPluginStorage;
  extension?: IPluginExtensionBridge;
  hooks?: {
    beforeToolCall: Array<(toolName: string, args: Record<string, any>, session?: any) => Promise<any> | void>;
    afterToolCall: Array<(toolName: string, args: Record<string, any>, result: any, session?: any) => Promise<any> | void>;
    onDOMMutation: Array<DOMMutationHook>;
    onPageNavigate: Array<(url: string, session?: any) => Promise<void> | void>;
  };
  onBeforeAction?: BeforeActionHook;
  onAfterAction?: AfterActionHook;
  onDOMMutation?: DOMMutationHook;
  onLoad?: (ctx: PluginContext) => Promise<void> | void;
  onUnload?: (ctx: PluginContext) => Promise<void> | void;
}
