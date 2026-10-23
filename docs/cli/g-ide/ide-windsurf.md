---
title: "Windsurf"
description: "Configure Weavetab as an MCP server for Windsurf IDE."
product: mcp
section: cli
group: g-ide
icon: Wind
slug: ide-windsurf
---

# Windsurf Integration

Add to `~/.windsurf/mcp_config.json`:

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
