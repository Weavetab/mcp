---
title: "Antigravity IDE"
description: "Configure Weavetab for Google Antigravity IDE."
product: mcp
section: cli
group: g-ide
icon: Rocket
slug: ide-antigravity
---

# Antigravity IDE Integration

Add to `~/.antigravity/mcp.json` or workspace `mcp.json`:

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
