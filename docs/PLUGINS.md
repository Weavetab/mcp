# Weavetab Plugin System & SDK Specification

> **Version:** 2.6.1 | **SDK:** @weavetab/sdk (MIT) | **Runtime:** AGPL-3.0-only

The **Weavetab Plugin System** allows developers to extend the MCP runtime with custom tools, visual HUD overlays, thought bubbles, lifecycle hooks, and tool overrides.

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
import { definePlugin, type PluginContext } from "@weavetab/sdk";

export default definePlugin({
  name: "weavetab-plugin-sample",
  version: "1.0.0",
  description: "Sample custom tool plugin for Weavetab",

  defaultConfig: {
    enableHud: true,
  },

  async onLoad(ctx: PluginContext) {
    // Register a custom MCP tool
    ctx.mcp.registerTool({
      name: "custom_analyzer",
      description: "Performs custom DOM analysis",
      schema: {
        type: "object",
        properties: {
          selector: { type: "string", description: "Target CSS selector" }
        },
        required: ["selector"]
      },
      handler: async (args: { selector: string }, session: any) => {
        // Show thought bubble on the browser tab
        if (ctx.config.enableHud && session) {
          await ctx.extension.showThought(session, `Analyzing ${args.selector}`);
        }

        return {
          content: [
            { type: "text", text: `Analysis complete for ${args.selector}` }
          ]
        };
      }
    });
  },

  async onUnload(ctx: PluginContext) {
    // Cleanup resources
  }
});
```

---

## 3. Manifest Specification (weavetab.json)

Plugins require a `weavetab.json` manifest in their package root:

```json
{
  "$schema": "https://weavetab.dev/schema/plugin.json",
  "name": "weavetab-plugin-sample",
  "version": "1.0.0",
  "entry": "dist/index.js",
  "engines": {
    "weavetab": ">=2.6.0",
    "node": ">=18.0.0"
  },
  "permissions": {
    "extension": { "hud": true, "reason": "Displays HUD thoughts" },
    "cdp": { "evaluate": true, "reason": "Runs DOM analysis" },
    "tools": { "add": true, "reason": "Registers the custom_analyzer tool" }
  },
  "tools": [
    {
      "name": "custom_analyzer",
      "description": "Performs custom DOM analysis"
    }
  ]
}
```

> Registering tools at runtime via `ctx.mcp.registerTool()` requires `permissions.tools.add`. Registering `/` commands via `ctx.mcp.registerPrompt()` requires `permissions.prompts.add`, and registering `@` mentions via `ctx.mcp.registerResource()` requires `permissions.resources.add`.

### Registering `/` Commands (MCP Prompts) & `@` Mentions (MCP Resources)

MCP clients surface **prompts** as `/` slash commands and **resources** as `@` context mentions. Plugins can register both statically on `definePlugin({ prompts, resources })` or dynamically in `onLoad`:

```typescript
import { definePlugin, definePrompt, defineResource, z } from "@weavetab/sdk";

export default definePlugin({
  name: "@weavetab/plugin-sample",
  version: "1.0.0",
  async onLoad(ctx) {
    // `/` command
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

    // `@` mention (fixed URI or RFC 6570 uriTemplate with autocomplete)
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
| **Sandboxed Storage** | `ctx.storage.get()`, `ctx.storage.set()` | Isolated key-value storage in `~/.weavetab/plugins/<name>/`. |
| **Thought Bubbles** | `ctx.extension.showThought(session, text)` | Floating green thoughts on the live browser tab. |
| **HUD Badges** | `ctx.extension.setHudState(session, state)` | Real-time status in the Weavetab overlay. |
| **Tool Overrides** | `ctx.mcp.overrideTool(name, wrapperFn)` | Wrap or intercept built-in MCP tools with custom pre/post logic. |
| **`/` Commands (Prompts)** | `ctx.mcp.registerPrompt(prompt)` | Register slash commands in MCP clients (`permissions.prompts.add`). |
| **`@` Mentions (Resources)** | `ctx.mcp.registerResource(resource)` | Register fixed-URI or RFC 6570 URI-template mentions with autocomplete (`permissions.resources.add`). |
| **Lifecycle Hooks** | `ctx.hooks.beforeToolCall`, `ctx.hooks.afterToolCall` | Global auditing and security filters. |

---

## 5. Installing Plugins

Plugins are installed directly from npm into `~/.weavetab/plugins/` using the Weavetab CLI:

```bash
# Install a plugin by package name (or official short alias):
weavetab plugin add <plugin-name>

# Install from a local directory during plugin development:
weavetab plugin add ./path/to/plugin

# List all active installed plugins:
weavetab plugin list

# Remove an installed plugin:
weavetab plugin rm <plugin-name>
```

---

## 6. Preflight & Testing

Before publishing to npm, verify your plugin with the official SDK preflight audit and testing harness:

```bash
# Run SDK preflight audit (manifest, licenses, permissions, naming anti-squatting):
npx @weavetab/sdk preflight

# Offline unit testing without launching Chrome:
npm test
```

Installed plugins mount automatically on server startup. Tool results returned as strings, markdown, or JSON objects are normalized directly into MCP standard content format.
