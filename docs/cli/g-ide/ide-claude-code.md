---
title: "Claude Code"
description: "Configure Weavetab for Claude Code CLI agent."
product: mcp
section: cli
group: g-ide
icon: MessageSquare
slug: ide-claude-code
---

# Claude Code Integration

Add to project `.claude/settings.json` or global configuration:

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
