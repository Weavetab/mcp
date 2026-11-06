# Weavetab Plugin System & SDK Specification

> **Version:** 2.6.2 | **SDK:** @weavetab/sdk (MIT) | **Runtime:** AGPL-3.0-only

The **Weavetab Plugin System** allows developers to extend the MCP runtime and CLI with custom MCP **Tools**, terminal CLI **Commands** (`weavetab plugin use`), **Utilities** (`/` Prompts and `@` Resources), visual HUD overlays, lifecycle hooks, tool overrides, and a strictly bounded `AGENTS.md` playbook.

---

## 1. Quick Start

### Scaffold a New Plugin

```bash
npx @weavetab/sdk init my-custom-plugin
cd my-custom-plugin
npm install
```

### Build & Compile

```bash
npm run build
```

---

## 2. Plugin Architecture

Every Weavetab plugin exports a plugin definition created with `definePlugin`:

```typescript
// src/index.ts
import { definePlugin, defineTool, defineCommand, z, type PluginContext } from "@weavetab/sdk";

export default definePlugin({
  name: "weavetab-plugin-sample",
  version: "1.0.0",
  description: "Sample custom tool and CLI command plugin for Weavetab",
  agentsMd: "AGENTS.md",

  defaultConfig: {
    enableHud: true,
  },

  async onLoad(ctx: PluginContext) {
    // 1. Register a custom MCP tool (gated by permissions.tools.add)
    ctx.mcp.registerTool(
      defineTool({
        name: "custom_analyzer",
        description: "Performs custom DOM analysis",
        schema: {
          selector: z.string().describe("Target CSS selector"),
        },
        handler: async (args, session) => {
          if (ctx.config.enableHud && session) {
            await ctx.extension.showThought(session, `Analyzing ${args.selector}`);
          }
          return {
            content: [{ type: "text", text: `Analysis complete for ${args.selector}` }],
          };
        },
      })
    );

    // 2. Register a CLI command (gated by permissions.commands.add)
    ctx.cli.registerCommand(
      defineCommand({
        name: "status",
        description: "Print plugin status from the terminal",
        usage: "weavetab plugin use weavetab-plugin-sample status",
        schema: {},
        handler: async () => ({ status: "ready", enableHud: ctx.config.enableHud }),
      })
    );
  },

  async onUnload(ctx: PluginContext) {
    // Cleanup resources
  }
});
```

---

## 3. Manifest Specification (`weavetab.json`) & Mandatory `AGENTS.md`

Plugins require a `weavetab.json` manifest and a strictly bounded `AGENTS.md` playbook (`<= 80` lines, `<= 3,200` characters) at their package root:

```json
{
  "$schema": "https://weavetab.dev/schema/plugin.json",
  "name": "weavetab-plugin-sample",
  "version": "1.0.0",
  "entry": "dist/index.js",
  "agentsMd": "AGENTS.md",
  "engines": {
    "weavetab": ">=2.6.2",
    "node": ">=18.0.0"
  },
  "permissions": {
    "extension": { "hud": true, "reason": "Displays HUD thoughts" },
    "cdp": { "evaluate": true, "reason": "Runs DOM analysis" },
    "tools": { "add": true, "reason": "Registers the custom_analyzer tool" },
    "commands": { "add": true, "reason": "Registers the status CLI command" }
  },
  "tools": [
    {
      "name": "custom_analyzer",
      "description": "Performs custom DOM analysis"
    }
  ],
  "commands": [
    {
      "name": "status",
      "description": "Print plugin status from the terminal",
      "usage": "weavetab plugin use weavetab-plugin-sample status"
    }
  ]
}
```

> Registering MCP tools via `ctx.mcp.registerTool()` requires `permissions.tools.add`. Registering CLI commands via `ctx.cli.registerCommand()` requires `permissions.commands.add`. Registering `/` Prompts via `ctx.mcp.registerPrompt()` requires `permissions.prompts.add`, and registering `@` Resources via `ctx.mcp.registerResource()` requires `permissions.resources.add`.

### Registering Utilities (`/` Prompts & `@` Resources)

MCP clients surface **Prompts** as `/` shortcuts and **Resources** as `@` context mentions (grouped under **Utilities** on `/discover`). Plugins can register both statically on `definePlugin({ prompts, resources })` or dynamically in `onLoad`:

```typescript
import { definePlugin, definePrompt, defineResource, z } from "@weavetab/sdk";

export default definePlugin({
  name: "@weavetab/plugin-sample",
  version: "1.0.0",
  agentsMd: "AGENTS.md",
  async onLoad(ctx) {
    // `/` Prompt utility
    ctx.mcp.registerPrompt(
      definePrompt({
        name: "audit_form",
        description: "Inject a checklist to audit the active page's forms",
        arguments: { focus: z.string().optional().describe("Optional form selector") },
        handler: async ({ focus }, { tab }) => {
          const url = (await tab?.url()) || "detached";
          return `Audit forms on ${url}${focus ? ` matching ${focus}` : ""}.`;
        },
      })
    );

    // `@` Resource utility (fixed URI or RFC 6570 uriTemplate with autocomplete)
    ctx.mcp.registerResource(
      defineResource({
        name: "rule-by-id",
        uriTemplate: "sample://rule/{id}",
        description: "Inspect an active rule by id",
        mimeType: "application/json",
        list: async () => [{ uri: "sample://rule/default", name: "default" }],
        complete: { id: (prefix) => ["default", "strict"].filter((k) => k.startsWith(prefix)) },
        read: async (uri, { id }) => JSON.stringify({ uri, id, active: true }, null, 2),
      })
    );
  },
});
```

Reserved URI schemes (`weavetab://`, `file://`, `http://`, `https://`, `data://`, `javascript://`) and prompt names colliding with core (`/page_context`, `/agent`) are rejected automatically. All prompt and resource outputs pass through `SessionSecretTracker.redactAll()` before leaving the server.

---

## 4. Plugin Capabilities

| Capability | API | Description |
| :--- | :--- | :--- |
| **MCP Tools** | `ctx.mcp.registerTool(tool)` | Register callable MCP tools (`permissions.tools.add`). |
| **CLI Commands** | `ctx.cli.registerCommand(cmd)` | Register terminal CLI commands invoked via `weavetab plugin use <pkg> <cmd>` (`permissions.commands.add`). |
| **Utilities: `/` Prompts** | `ctx.mcp.registerPrompt(prompt)` | Register `/` prompt templates in MCP clients (`permissions.prompts.add`). |
| **Utilities: `@` Resources** | `ctx.mcp.registerResource(resource)` | Register `@` resources or RFC 6570 URI templates (`permissions.resources.add`). |
| **`AGENTS.md` Playbook** | `agentsMd: "AGENTS.md"` | Bounded (`<= 80` lines, `<= 3,200` chars) AI agent playbook exposed at `weavetab://plugins/<slug>/agents`. |
| **Sandboxed Storage** | `ctx.storage.get()`, `ctx.storage.set()` | Isolated key-value storage in `~/.weavetab/plugins/<name>/`. |
| **Thought Bubbles** | `ctx.extension.showThought(session, text)` | Floating green thoughts on the live browser tab. |
| **HUD Badges** | `ctx.extension.setHudState(session, state)` | Real-time status in the Weavetab overlay. |
| **Tool Overrides** | `ctx.mcp.overrideTool(name, wrapperFn)` | Wrap or intercept built-in MCP tools with custom pre/post logic. |
| **Lifecycle Hooks** | `ctx.hooks.onBeforeAction`, `ctx.hooks.onAfterAction` | Global auditing and security filters. |

---

## 5. Installing & Running Plugins from the CLI

Plugins are installed directly from npm into `~/.weavetab/plugins/` using the Weavetab CLI:

```bash
# Install a plugin by package name (or official short alias):
weavetab plugin add <plugin-name>

# Run a plugin's CLI command or MCP tool:
weavetab plugin use <plugin-name> <command-or-tool> [--flags]

# View a plugin's AGENTS.md playbook:
weavetab plugin agents <plugin-name>

# List all active installed plugins:
weavetab plugin list

# Remove an installed plugin:
weavetab plugin rm <plugin-name>
```

---

## 6. Preflight & Testing (`AGENTS.md` Budget Enforcement)

Before publishing to npm, verify your plugin with the official SDK preflight audit and testing harness. `@weavetab/sdk` rejects any plugin whose `AGENTS.md` is missing or exceeds `80` lines / `3,200` characters:

```bash
# Run SDK preflight audit (manifest, AGENTS.md budget, permissions, naming anti-squatting):
npx @weavetab/sdk preflight

# Offline unit testing without launching Chrome:
npm test
```

Installed plugins mount automatically on server startup. Tool results returned as strings, markdown, or JSON objects are normalized directly into MCP standard content format.
