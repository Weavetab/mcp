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
| **WebSocket** | `--ws` | JSON-RPC 2.0 / WebSocket | Custom agents, Python/Go backends, remote daemons, n8n |

## stdio (Default)

The MCP client spawns Weavetab as a child process and pipes messages over stdin/stdout. No network port is opened:

```json
{
  "mcpServers": {
    "weavetab": {
      "command": "weavetab"
    }
  }
}
```

## WebSocket

```bash
weavetab --ws --port 3000
```

WebSocket mode binds strictly to `127.0.0.1` for local security. Front it with your own TLS/auth layer if exposing across a private network.
