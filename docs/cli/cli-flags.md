---
title: "Flags"
description: "Global flags accepted by the CLI."
product: mcp
section: cli
icon: Flag
slug: cli-flags
---

# Flags

Only these flags are parsed by the CLI (`MCP/src/index.ts`). Anything else is ignored.

| Flag | Type | Description |
|---|---|---|
| `--help` / `-h` | boolean | Show help message and exit |
| `help` | command | Show help message and exit |
| `--version` / `-v` | boolean | Print version and exit |
| `--ws` | boolean | Start the WebSocket daemon instead of stdio |
| `--port <port>` / `--port=<port>` | number | Port for the WebSocket daemon (default `3000`) |
| `--yes` / `-y` | boolean | Skip confirmation prompt when running `weavetab reset` / `reload` |
| `--official` / `-O` | boolean | Prefer the official `@weavetab/plugin-<name>` candidate (`plugin add`) |
| `--community` / `-C` | boolean | Prefer the community package candidate (`plugin add`) |
| `--refresh` | boolean | Invalidate and refresh the verified plugin cache (`plugin`) |
| `--project` | boolean | Project-scoped secrets file (`secrets init --project`) |

Notes:
- There are no `--headless` / `--role` CLI flags. Browser headless mode and RBAC role come from `~/.weavetab/config.json` (`weavetab config` / `weavetab view`). The wizard offers `admin` / `operator` / `viewer` / `automation`.
