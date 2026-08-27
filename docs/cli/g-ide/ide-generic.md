---
title: "Generic / WebSocket"
description: "Connect any MCP-compatible client via WebSocket or stdio."
product: mcp
section: cli
group: g-ide
icon: Globe
slug: ide-generic
---

# Generic Client Integration

Any client speaking MCP JSON-RPC 2.0 can connect to Weavetab.

## stdio Transport (Default)

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

## WebSocket Transport

```bash
weavetab --ws --port 3000
```

Connect your client over WebSocket to `ws://127.0.0.1:3000`.
