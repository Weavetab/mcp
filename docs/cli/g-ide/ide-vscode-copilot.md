---
title: "VS Code + Copilot"
description: "Configure Weavetab for VS Code with GitHub Copilot."
product: mcp
section: cli
group: g-ide
icon: Code
slug: ide-vscode-copilot
---

# VS Code + GitHub Copilot Integration

Create `.vscode/mcp.json` in your workspace root:

```json
{
  "servers": {
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
