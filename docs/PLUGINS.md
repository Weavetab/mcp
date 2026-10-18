# Weavetab Plugin System & SDK Specification

> **Version:** 2.5.1 | **SDK:** @weavetab/sdk (MIT) | **Runtime:** AGPL-3.0-only

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
    "weavetab": "^2.5.1",
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

> Registering tools at runtime via `ctx.mcp.registerTool()` requires the `permissions.tools.add` permission.

---

## 4. Plugin Capabilities

| Capability | API | Description |
| :--- | :--- | :--- |
| **Sandboxed Storage** | `ctx.storage.get()`, `ctx.storage.set()` | Isolated key-value storage in `~/.weavetab/plugins/<name>/`. |
| **Thought Bubbles** | `ctx.extension.showThought(session, text)` | Floating green thoughts on the live browser tab. |
| **HUD Badges** | `ctx.extension.setHudState(session, state)` | Real-time status in the Weavetab overlay. |
| **Tool Overrides** | `ctx.mcp.overrideTool(name, wrapperFn)` | Wrap or intercept built-in MCP tools with custom pre/post logic. |
| **Lifecycle Hooks** | `ctx.hooks.beforeToolCall`, `ctx.hooks.afterToolCall` | Global auditing and security filters. |

---

## 5. Installing Plugins

```bash
# Install a plugin by npm package name
weavetab plugin add my-custom-plugin

# Install from a local path
weavetab plugin add ./my-plugin

# List installed plugins
weavetab plugin list

# Remove a plugin
weavetab plugin rm my-custom-plugin
```

Restart Weavetab to load the newly installed plugin tools into the MCP server.
