---
title: "Cursor"
description: "Configure Weavetab as an MCP server for Cursor IDE."
product: mcp
section: cli
group: g-ide
icon: MousePointer2
slug: ide-cursor
---

# Cursor Integration

## Config File Location

| Scope | Path |
|---|---|
| **Global** | `~/.cursor/mcp_config.json` |
| **Project** | `.cursor/mcp.json` (in project root) |

## Configuration

```json
{
  "mcpServers": {
    "weavetab": {
      "command": "weavetab",
      "args": []
    }
  }
}
```
