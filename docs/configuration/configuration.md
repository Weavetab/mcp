---
title: "Schema"
description: "Every field on the runtime config object."
product: mcp
section: configuration
icon: Settings2
slug: configuration
---

# Configuration Schema

The full `Config` interface lives in `src/config/loader.ts`.

```typescript
export type PolicyMode    = "allow" | "deny" | "audit-only" | "read-only";
export type Role          = "admin" | "operator" | "viewer" | "automation";
export type BrowserEngine = "chromium" | "firefox" | "webkit";

export interface ElectronAppConfig {
  path?: string;               // Absolute path to Electron app executable
  port?: number;               // Remote debugging port (default 9222)
  url?: string;                // Initial launch URL / deep-link
  args?: string[];             // Custom CLI arguments
  profileDir?: string;         // Dedicated isolated user profile directory
}

export interface Config {
  // Mode & Port
  mode: "session" | "attach";
  session: string;
  attachPort: number;

  // Browser Settings
  browser: string;              // Executable path or "auto"
  browserType: BrowserEngine;
  profileDir: string;
  headless: boolean;
  extension: boolean;           // Enable Weavetab Chrome extension
  browserFlags: string[];

  // Desktop & Electron Applications
  electron?: Record<string, string | number | ElectronAppConfig>;

  // Security & Policy
  block: string[];              // Domain blocklist
  allow: string[];              // Domain allowlist
  policies: PolicyEntry[];      // Per-domain policy modes
  role: Role;                   // RBAC role
  cookies: boolean;             // Allow storage & cookies
  proxy?: string;               // Outbound proxy URL

  // Rate Limiting & Resource Caps
  maxActionsPerMinute: number;  // 1-600 (default 60)
  maxTabs: number;              // 1-100 (default 10)

  // Timing & Thresholds
  sessionTimeout: number;       // Seconds (default 3600)
  navigationTimeout: number;    // Milliseconds (default 30000)
  idleTimeout: number;          // Milliseconds (default 15000)
  actionabilityTimeoutMs: number; // Milliseconds (default 500)

  // UI & Overlay
  devMode: boolean | DevModeConfig;
  persona: "concise" | "friendly";

  // Telemetry & GitHub
  telemetry: boolean;
  githubCacheTtlMs: number;

  // Agent Identity
  agentId: string;              // Auto-generated UUID
}
```
