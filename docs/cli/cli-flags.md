---
title: "Flags"
description: "Global flags accepted by the server."
product: mcp
section: cli
icon: Flag
slug: cli-flags
---

# Flags

| Flag | Type | Description |
|---|---|---|
| `--version` | boolean | Print CLI version and exit |
| `--help` / `-h` | boolean | Show help message and exit |
| `--ws` | boolean | Start server in WebSocket mode instead of stdio |
| `--port <port>` | number | Port for WebSocket server (default `3000`) |
| `--headless` | boolean | Run browser in headless mode |
| `--role <role>` | enum | Override RBAC role (`admin`, `operator`, `viewer`, `automation`) |
| `--yes` / `-y` | boolean | Skip confirmation prompt when running `weavetab reset` |
