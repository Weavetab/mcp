# Weavetab Plugin System & SDK Specification

> **Version:** 2.5.0 | **SDK:** @weavetab/sdk (MIT) | **Runtime:** AGPL-3.0-only

The **Weavetab Plugin System** allows developers to extend the MCP runtime with custom tools, visual HUD overlays, thought bubbles, lifecycle hooks, and tool overrides.

---

## 1. Quick Start

### Scaffold a New Plugin
````bash
npx @weavetab/sdk init my-custom-plugin
cd my-custom-plugin
npm install
`

### Build & Compile
````bash
npm run build
`

---

## 2. Plugin Architecture

Every Weavetab plugin exports a plugin definition created with definePlugin:

`	ypescript
// src/index.ts
import { definePlugin, type PluginContext } from @weavetab/sdk;

export default definePlugin({
  name: weavetab-plugin-sample,
  version: 1.0.0,
  description: Sample custom tool plugin for Weavetab,

  defaultConfig: {
    enableHud: true,
  },

  async onLoad(ctx: PluginContext) {
    // Register a custom MCP tool
    ctx.mcp.registerTool({
      name: custom_analyzer,
      description: Performs custom DOM analysis,
      schema: {
        type: object,
        properties: {
          selector: { type: string, description: Target CSS selector }
        },
        required: [selector]
      },
      handler: async (args: { selector: string }, session: any) => {
        // Show thought bubble on browser tab
        if (ctx.config.enableHud && session) {
          await ctx.extension.showThought(session, Analyzing ...);
        }

        return {
          content: [
            { type: text, text: Analysis complete for  }
          ]
        };
      }
    });
  },

  async onUnload(ctx: PluginContext) {
    // Cleanup resources
  }
});
`

---

## 3. Manifest Specification (weavetab.json)

Plugins require a weavetab.json manifest in their package root:

`json
{
  name: weavetab-plugin-sample,
  version: 1.0.0,
  entry: ./dist/index.js,
  permissions: [storage, extension, cdp],
  tools: [custom_analyzer]
}
`

---

## 4. Plugin Capabilities

| Capability | API | Description |
| :--- | :--- | :--- |
| **Sandboxed Storage** | ctx.storage.get(), ctx.storage.set() | Isolated key-value storage in ~/.weavetab/plugins/<name>/. |
| **Thought Bubbles** | ctx.extension.showThought(session, text) | Floating green thoughts on the live browser tab. |
| **HUD Badges** | ctx.extension.setHudState(session, state) | Real-time status in the Weavetab overlay. |
| **Tool Overrides** | ctx.mcp.overrideTool(name, wrapperFn) | Wrap or intercept built-in MCP tools with custom pre/post logic. |
| **Lifecycle Hooks** | ctx.hooks.beforeToolCall, ctx.hooks.afterToolCall | Global auditing and security filters. |

---

## 5. Installing Plugins

```bash
# Install an official plugin
weavetab plugin add @weavetab/plugin-youtube

# Install community plugins (any npm package)
weavetab plugin add my-custom-plugin

# List installed plugins
weavetab plugin list

# Remove a plugin
weavetab plugin rm my-custom-plugin
`

Restart weavetab to load the newly installed plugin tools into the MCP server.
