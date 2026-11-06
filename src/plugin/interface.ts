import type { z } from "zod";
import type CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import type { IPluginStorage } from "./storage.js";
import type { IPluginExtensionBridge } from "./extension_bridge.js";

export interface WeavetabToolDefinition {
  name: string;
  description: string;
  schema: Record<string, z.ZodType<any>>;
  /**
   * When `false`, the host does NOT establish a browser/CDP session before
   * invoking this tool. Use for API-only tools. Defaults to `true`.
   */
  requiresSession?: boolean;
  handler: (args: Record<string, any>, sessionOrContext: any, config?: Config) => Promise<any>;
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

export interface WeavetabManifestCommand {
  name: string;
  description: string;
  usage?: string;
  parameters?: Record<string, any>;
  schema?: Record<string, any>;
  examples?: string[];
  requiresSession?: boolean;
}

export interface WeavetabManifestPrompt {
  name: string;
  description?: string;
  arguments?: Record<string, any>;
}

export interface WeavetabManifestResource {
  name: string;
  uri?: string;
  uriTemplate?: string;
  description?: string;
  mimeType?: string;
}

export interface WeavetabPermissions {
  /** CLI commands (`weavetab plugin use <plugin> <cmd>`) */
  commands?: {
    add?: boolean;
    reason?: string;
  };
  /** `/` prompt utilities (MCP prompts) */
  prompts?: {
    add?: boolean;
    reason?: string;
  };
  /** `@` resource utilities (MCP resources) */
  resources?: {
    add?: boolean;
    reason?: string;
  };
  desktop?: {
    apps?: string[];
    reason?: string;
  };
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
  /** @deprecated use `filesystem` */
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
    /** Must be true for the plugin to register any new MCP tools */
    add?: boolean;
    /** Explicit list of built-in tool names this plugin may override */
    override?: string[];
    /** Explicit list of built-in tool names this plugin may remove */
    remove?: string[];
    reason?: string;
  };
  hooks?: {
    onBeforeAction?: boolean;
    onAfterAction?: boolean;
    onDOMMutation?: boolean;
    onPageNavigate?: boolean;
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
  /** Optional display title */
  displayName?: string;
  /** Semantic version string */
  version: string;
  /** Short summary of what this plugin provides */
  description?: string;
  /** Entry point file relative to the plugin root (e.g., 'dist/index.js') */
  entry?: string;
  /** System instructions injected directly into AI agent MCP context (max 3200 characters) */
  instructions?: string;
  /** @deprecated use `instructions` declared directly in weavetab.json */
  agentsMd?: string;
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
  /** Tools exposed by this plugin to the MCP server */
  tools?: WeavetabManifestTool[];
  /** CLI commands exposed by this plugin (`weavetab plugin use <plugin> <cmd>`) */
  commands?: WeavetabManifestCommand[];
  /** `/` prompt utilities this plugin registers */
  prompts?: WeavetabManifestPrompt[];
  /** `@` resource utilities this plugin registers */
  resources?: WeavetabManifestResource[];
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
  /** See {@link WeavetabToolDefinition.requiresSession}. Defaults to `true`. */
  requiresSession?: boolean;
  handler: (args: TArgs, session?: any, config?: any) => Promise<any>;
}

export interface PluginCommandContext {
  args: string[];
  flags: Record<string, any>;
  tab?: any;
  desktop?: any;
  storage: IPluginStorage;
  config: Record<string, any>;
  logger: PluginContext["logger"];
  session?: any;
  getSession?: () => Promise<any>;
  [key: string]: any;
}

export interface WeavetabPluginCommand<TArgs = any> {
  name: string;
  description: string;
  usage?: string;
  schema?: Record<string, any> | Record<string, z.ZodType<any>>;
  parameters?: Record<string, any>;
  examples?: string[];
  /** When true, establishes a browser/CDP session before running the command. Defaults to false. */
  requiresSession?: boolean;
  handler: (args: TArgs, ctx: PluginCommandContext) => Promise<any> | any;
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

export interface PluginSurfaceContext {
  /** live tab helper, undefined when no browser session is open yet */
  tab?: any;
  storage: IPluginStorage;
  config: Record<string, any>;
  logger: PluginContext["logger"];
}

export type PromptReturn =
  | string
  | {
      description?: string;
      messages: Array<{ role: "user" | "assistant"; content: string | { type: "text"; text: string } }>;
    };

export type ResourceReturn =
  | string
  | { text: string; mimeType?: string }
  | { blob: string; mimeType?: string }
  | { contents: Array<{ uri?: string; text?: string; blob?: string; mimeType?: string }> };

type ListedResource = { uri: string; name: string; description?: string; mimeType?: string };

export interface WeavetabPluginPrompt {
  name: string;
  title?: string;
  description?: string;
  /** Zod raw shape (string fields) or JSON Schema. MCP prompt arguments are always strings. */
  arguments?: Record<string, any>;
  handler: (args: Record<string, string>, ctx: PluginSurfaceContext) => Promise<PromptReturn> | PromptReturn;
}

export interface WeavetabPluginResource {
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** Fixed URI, e.g. `realtime://state`. Exactly one of uri / uriTemplate. */
  uri?: string;
  /** RFC 6570 template, e.g. `realtime://reflex/{id}`. */
  uriTemplate?: string;
  /** Template only: entries offered in the `@` picker. */
  list?: (ctx: PluginSurfaceContext) => Promise<ListedResource[]> | ListedResource[];
  /** Template only: autocomplete per `{variable}`. */
  complete?: Record<string, (value: string) => Promise<string[]> | string[]>;
  /** `vars` is empty for fixed URIs. */
  read: (uri: string, vars: Record<string, string | string[]>, ctx: PluginSurfaceContext) => Promise<ResourceReturn> | ResourceReturn;
}

export interface PluginCliContext {
  registerCommand: (command: WeavetabPluginCommand) => void;
  unregisterCommand?: (name: string) => void;
}

export interface PluginMcpContext {
  registerPrompt: (prompt: WeavetabPluginPrompt) => void;
  registerResource: (resource: WeavetabPluginResource) => void;
  registerCommand?: (command: WeavetabPluginCommand) => void;
  unregisterPrompt?: (name: string) => void;
  /** by fixed uri, or by name for templates */
  unregisterResource?: (uriOrName: string) => void;
  unregisterCommand?: (name: string) => void;
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
  tab?: any;
  desktop?: any;
  extension: IPluginExtensionBridge;
  mcp: PluginMcpContext;
  cli: PluginCliContext;
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
  commands?: WeavetabPluginCommand[];
  prompts?: WeavetabPluginPrompt[];
  resources?: WeavetabPluginResource[];
  /** System instructions injected directly into AI agent MCP context */
  instructions?: string;
  /** @deprecated use `instructions` */
  agentsMd?: string;
  overrides?: WeavetabToolOverride[];
  removeTools?: string[];
  defaultConfig?: Record<string, any>;
  permissions?: WeavetabPermissions;
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
  permissions?: WeavetabPermissions;
  /** Add new tools */
  tools?: WeavetabToolDefinition[] | WeavetabPluginTool[];
  /** Add CLI commands (`weavetab plugin use <plugin> <cmd>`) */
  commands?: WeavetabPluginCommand[];
  /** Add `/` prompt utilities */
  prompts?: WeavetabPluginPrompt[];
  /** Add `@` resource utilities */
  resources?: WeavetabPluginResource[];
  /** System instructions injected into AI agent context (from weavetab.json or legacy AGENTS.md) */
  instructions?: string;
  /** Loaded AGENTS.md playbook content (strictly bounded) */
  agentsMdContent?: string;
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
