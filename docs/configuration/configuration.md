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
export type DevModeConfig  = boolean;
export type PolicyMode     = "allow" | "deny" | "audit-only" | "read-only";
export type Role           = "admin" | "operator" | "viewer" | "automation" | "system";
export type BrowserEngine  = "chromium" | "firefox" | "webkit";

export interface PolicyEntry {
  pattern: string;
  mode: PolicyMode;
}

export interface ElectronAppConfig {
  path?: string;               // Absolute path to Electron app executable
  port?: number;               // Remote debugging port (default 9222)
  url?: string;                // Initial launch URL / deep-link
  args?: string[];             // Custom CLI arguments
  profileDir?: string;         // Dedicated isolated user profile directory
}

export interface Config {
  // Identity & Transport
  mode: "session" | "attach";
  session: string;
  attachPort: number;           // 0-65535, 0 = dynamic
  agentId: string;              // Auto-generated UUID (WT_AGENT_ID to override)
  telemetry: boolean;

  // Browser Settings
  browserPath: string;          // Executable path or "auto"
  browserType: BrowserEngine;
  headless: boolean;
  extension: boolean;           // Enable Weavetab Chrome extension
  browserFlags: string[];
  profileDir: string;
  cookies: boolean;
  syncDataAcrossBrowsers: boolean;

  // Desktop & Electron Applications
  apps?: Record<string, ElectronAppConfig>;
  electron?: Record<string, ElectronAppConfig>;

  // Security & Policy
  role: Role;                   // RBAC role
  block: string[];              // Domain blocklist (default: ["*.bank.*", "paypal.com"])
  allow: string[];              // Domain allowlist
  policies: PolicyEntry[];      // Per-domain policy modes
  proxy?: string;               // Outbound proxy URL (WT_PROXY_URL to override)

  // Rate Limiting & Resource Caps
  sessionTimeout: number;       // Seconds, 60-86400 (default 3600)
  navigationTimeout: number;    // Milliseconds, 1000-120000 (default 30000)
  idleTimeout: number;          // Milliseconds, >= 5000 (default 60000)
  actionabilityTimeoutMs: number; // Milliseconds, 50-15000 (default 300)
  maxTabs: number;              // 1-100 (default 10)
  maxActionsPerMinute: number;  // 1-600 (default 60)
  githubCacheTtlMs: number;     // Milliseconds (default 1800000)
  refCacheTtlMs: number;        // Milliseconds (default 30000)

  // Output Directories
  downloadDir: string;
  pdfDir: string;
  snapshotDir: string;
  recordingDir: string;
  designDir: string;

  // UI & Overlay
  devMode: DevModeConfig;
}
```

The on-disk `config.json` may also use the legacy sectioned shape (`general`, `browser`,
`security`, `performance`); the loader migrates it to this flat interface automatically.
