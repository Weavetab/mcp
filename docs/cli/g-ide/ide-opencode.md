---
title: "OpenCode"
description: "Configure Weavetab for OpenCode CLI agent."
product: mcp
section: cli
group: g-ide
icon: Terminal
slug: ide-opencode
---

# OpenCode Integration

Add to `.opencode/config.json` or `opencode.json`:

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
