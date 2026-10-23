---
title: "Quickstart"
description: "Install, configure, and run a first mission in under a minute."
product: mcp
section: get-started
icon: Zap
slug: quickstart
---

# Quickstart

Get Weavetab attached to your agent and running a real browser mission in three simple steps.

## 1. Install Weavetab

```bash
# Global installation (recommended)
npm install -g @weavetab/mcp@latest

# Or run directly with npx
npx -y @weavetab/mcp@latest
```

## 2. Wire to your MCP Client

Point any MCP-compatible client (Claude Desktop, Cursor, Windsurf, VS Code, Antigravity) at the server:

```json
{
  "mcpServers": {
    "weavetab": {
      "command": "npx",
      "args": [
        "-y",
        "@weavetab/mcp"
      ]
    }
  }
}
```

## 3. Run a First Mission

Use `browser_burst` to chain multiple actions in a single round-trip:

```json
{
  "name": "browser_burst",
  "arguments": {
    "steps": [
      { "tool": "navigate_and_read", "url": "https://example.com" },
      { "tool": "click_and_wait", "selector": "#login-btn" }
    ]
  }
}
```

You will see the browser launch, the Ghost Cursor glide across the page along human Bézier curves, and the agent complete the task with sub-10ms CDP execution.
