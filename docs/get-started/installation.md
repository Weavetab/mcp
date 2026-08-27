---
title: "Installation"
description: "Install Weavetab globally or run it ad-hoc with npx."
product: mcp
section: get-started
icon: Download
slug: installation
---

# Installation

```bash
# Global installation (recommended)
npm install -g @weavetab/mcp@latest

# Or run directly without installation
npx -y @weavetab/mcp@latest

# Install Developer SDK as dev dependency in a project
npm install -D @weavetab/sdk@latest

# Verify installation
weavetab --version
# → @weavetab/mcp 2.5.0
```

## System Requirements

- **Node.js** >= 18.0.0 (Node 20 or 22 LTS recommended)
- **Chromium-based browser** (Google Chrome, Microsoft Edge, Brave, or Chromium)
- *Optional:* Firefox or Safari Technology Preview via `browserType` config
- *Optional for Desktop Automation:* Any Electron application (Discord, VS Code, Figma, Obsidian, Postman, etc.)

## CLI Binary Aliases

```bash
weavetab          # standard binary
Weavetab          # case-insensitive alias
```

## What Gets Configured

Weavetab ships as a single, self-contained Node package. On first run it:

1. Auto-detects an installed Chromium binary on `$PATH`
2. Creates `~/.weavetab/` for global configuration, secrets, and policy rules
3. Registers a local MCP entry point that clients launch over stdio or WebSocket
