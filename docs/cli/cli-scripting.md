---
title: "Scripting & CI/CD"
description: "Chain CLI calls in shell scripts and CI."
product: mcp
section: cli
icon: FileCode
slug: cli-scripting
---

# Scripting & CI/CD

## Shell Scripting

```bash
# Reset before a fresh test run
weavetab reset --yes

# List stored secrets
weavetab secrets list

# List installed plugins
weavetab plugin list

# Start the MCP server in WebSocket daemon mode for custom scripts
weavetab --ws --port 3000 &
```

## CI/CD Pipeline

```bash
# In GitHub Actions or Docker CI
npm install -g @weavetab/mcp
weavetab reset --yes
weavetab --ws --port 3000 &
```
