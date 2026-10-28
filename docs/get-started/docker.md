---
title: "Docker & Production"
description: "Run Weavetab in Docker with headless Chromium."
product: mcp
section: get-started
icon: Container
slug: docker
---

# Docker & Production Deployment

Run the Weavetab MCP server headlessly inside Docker:

```dockerfile
FROM node:20-slim

# Install Chromium dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Install Weavetab MCP globally
RUN npm install -g @weavetab/mcp@latest

# Chromium is auto-detected at /usr/bin/chromium (browserPath: "auto").
# To pin a custom binary, mount a config.json with browserPath set.

# stdio transport: no ports are opened, no EXPOSE needed.
# The MCP client spawns `weavetab` and speaks JSON-RPC over stdin/stdout.
CMD ["weavetab"]
```

```bash
docker build -t weavetab-server .
docker run -v ~/.weavetab:/root/.weavetab weavetab-server
```
