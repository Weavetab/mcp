---
title: "Commands"
description: "Reference for every top-level subcommand."
product: mcp
section: cli
icon: ListTree
slug: cli-commands
---

# Commands

## Server Commands

| Command | Description |
|---|---|
| `weavetab` | Start the MCP server (stdio mode — default for MCP clients). When run in a TTY without arguments, launches the interactive UI menu. |
| `weavetab config` | Launch the 5-phase interactive configuration wizard. |
| `weavetab view` | Display the current active configuration report. Press **[R]** to view raw JSON, **[Q]** to quit. |
| `weavetab reset` | Purge browser profiles, lockfiles, mutexes, session registries, and kill orphan browser processes. Accepts `--yes`/`-y` to skip confirmation prompts. |
| `weavetab reload-ext` | Send a reload signal to the Weavetab browser extension via CDP `Runtime.evaluate`. |
| `weavetab help` / `--help` | Show full CLI help message with all commands, flags, and environment variables. |

## Secrets Management

Credentials are stored in `~/.weavetab/secrets.json` (global) or `.weavetab/secrets.json` (project-scoped). Values are never echoed to the terminal.

| Command | Description |
|---|---|
| `weavetab secrets set <KEY>` | Store a new encrypted secret. Prompts for value (hidden input) and allowed domains (comma-separated). |
| `weavetab secrets list` | List all stored secrets (key names only, values hidden). Shows domains and last-updated timestamps. |
| `weavetab secrets rm <KEY>` | Remove a secret by key name. |
| `weavetab secrets init --project` | Initialize a project-scoped `.weavetab/secrets.json` file. |

## Interactive TTY Menu

When run without arguments in a TTY terminal, Weavetab opens an interactive keyboard-driven menu:

| Key | Action |
|---|---|
| `[C]` | Launch the configuration wizard |
| `[V]` | View current active configuration |
| `[R]` | Purge browser profiles and lockfiles |
| `[H]` | Show help information |
| `[Q]` | Exit Weavetab |
