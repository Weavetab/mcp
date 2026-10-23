---
title: "Transport Modes"
description: "stdio vs WebSocket — pick the right wire for your client."
product: mcp
section: architecture
icon: Cable
slug: transport
---

# Transport Modes

| Mode | Flag | Protocol | Use Case |
|---|---|---|---|
| **stdio** | *(default)* | JSON-RPC 2.0 / stdio | Claude Desktop, Cursor, VS Code Copilot, Antigravity |
| **WebSocket** | `--ws [--port N]` | JSON-RPC 2.0 / WebSocket | Custom agents, Python/Go backends, remote daemons, n8n |

## stdio (Default)

The MCP client spawns Weavetab as a child process and pipes messages over stdin/stdout. No network port is opened:

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

## WebSocket

```bash
weavetab --ws --port 3000
```

Starts the daemon on `127.0.0.1:3000` (override with `--port <n>` / `--port=<n>`). The daemon binds strictly to loopback for local security — front it with your own TLS/auth layer if exposing across a private network.
