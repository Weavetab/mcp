---
title: "Claude Desktop"
description: "Configure Weavetab as an MCP server for Claude Desktop."
product: mcp
section: cli
group: g-ide
icon: Bot
slug: ide-claude-desktop
---

# Claude Desktop Integration

## Config File Location

| OS | Path |
|---|---|
| **macOS** | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| **Windows** | `%APPDATA%\Claude\claude_desktop_config.json` |
| **Linux** | `~/.config/Claude/claude_desktop_config.json` |

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
