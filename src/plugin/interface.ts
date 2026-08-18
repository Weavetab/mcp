import type { z } from "zod";
import type CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";

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
}

export interface WeavetabManifestPermissions {
  network?: {
    domains?: string[];
    intercept?: boolean;
    reason?: string;
  };
  cdp?: {
    evaluate?: boolean;
    navigate?: boolean;
    click?: boolean;
    input?: boolean;
    screenshot?: boolean;
    reason?: string;
    [key: string]: any;
  };
  fs?: {
    read?: string[];
    write?: string[];
    reason?: string;
  };
  tools?: {
    /** List of built-in tool names this plugin is permitted to override */
    override?: string[];
    /** List of built-in tool names this plugin is permitted to remove */
    remove?: string[];
    reason?: string;
  };
}

export interface WeavetabManifestAuthor {
  name: string;
  role?: string;
  avatar?: string;
  url?: string;
}

export interface WeavetabManifestLinks {
  github?: string;
  npm?: string;
  docs?: string;
  issues?: string;
  homepage?: string;
}

export interface WeavetabCompatibility {
  weavetab?: string;
  node?: string;
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
  /** Single author or multiple authors with roles */
  author?: string | WeavetabManifestAuthor | (string | WeavetabManifestAuthor)[];
  /** Array of authors */
  authors?: (string | WeavetabManifestAuthor)[];
  /** Path to plugin logo (e.g. "images/logo.svg" or "images/logo.png") */
  logo?: string;
  /** Path to plugin header banner (e.g. "images/banner.png" or "images/banner.webp") */
  banner?: string;
  /** Path to README markdown file (default: "README.md") */
  readme?: string;
  /** Category tags */
  tags?: string[];
  /** External links */
  links?: WeavetabManifestLinks;
  /** Runtime compatibility requirements */
  compatibility?: WeavetabCompatibility;
  /** Tools exposed by this plugin to the MCP server */
  tools?: WeavetabManifestTool[];
  /** Required permissions with security rationale */
  permissions?: WeavetabManifestPermissions;
  /** Open source license */
  license?: string;
}

export interface WeavetabPluginTool<TArgs = any> {
  name: string;
  description: string;
  schema?: Record<string, any> | Record<string, z.ZodType<any>>;
  inputSchema?: Record<string, any>;
  handler: (args: TArgs, session?: any, config?: any) => Promise<any>;
}

export interface WeavetabPluginDefinition {
  name: string;
  version: string;
  description?: string;
  tools?: WeavetabPluginTool[];
  overrides?: WeavetabToolOverride[];
  removeTools?: string[];
  onLoad?: () => Promise<void>;
  onUnload?: () => Promise<void>;
}

export interface WeavetabPlugin {
  name: string;
  version: string;
  description?: string;
  /** Add new tools */
  tools?: WeavetabToolDefinition[];
  /** Override or wrap existing tools */
  overrides?: WeavetabToolOverride[];
  /** Built-in tools to remove or disable */
  removeTools?: string[];
  manifest?: WeavetabManifest;
  onLoad?: () => Promise<void>;
  onUnload?: () => Promise<void>;
}
