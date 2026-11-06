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
| `weavetab --ws [--port N]` | Start the WebSocket daemon on `127.0.0.1` (default port `3000`). |
| `weavetab --version` | Print version and exit. |
| `weavetab config` | Launch the 6-phase interactive configuration wizard. |
| `weavetab view` | Display the current active configuration report. Press **[R]** to view raw JSON, **[Q]** to quit. |
| `weavetab reset` | Purge browser profiles, lockfiles, mutexes, session registries, and kill orphan browser processes. Accepts `--yes`/`-y` to skip confirmation prompts. |
| `weavetab reload-ext` | Send a reload signal to the Weavetab browser extension via CDP `Runtime.evaluate`. |
| `weavetab plugin <add\|use\|agents\|browse\|search\|list\|remove\|verify>` | Manage plugins, run plugin CLI commands (`weavetab plugin use <pkg> <cmd>`), or read `AGENTS.md` playbooks — see `weavetab plugin --help`. |
| `weavetab use <pkg> <cmd_or_tool> [--flags]` | Shorthand alias for `weavetab plugin use <pkg> <cmd_or_tool> [--flags]`. |
| `weavetab skills [options]` | Install or update AI agent skills (passthrough to `@weavetab/skills`). |
| `weavetab help` / `--help` | Show full CLI help message with all commands, flags, and environment variables. |

## Plugin CLI Execution (`weavetab plugin use`)

Installed plugins can expose dedicated CLI **Commands** (gated by `permissions.commands.add` in `weavetab.json`), MCP **Tools**, **Utilities** (`/` Prompts and `@` Resources), and a strictly bounded `AGENTS.md` playbook (`<= 80` lines, `<= 3200` chars).

```bash
# Inspect all commands, tools, utilities, and AGENTS.md for an installed plugin
weavetab plugin use github

# Execute a plugin CLI command with flags
weavetab plugin use github repo-summary --repo Weavetab/Weavetab

# Execute a plugin MCP tool directly from the terminal
weavetab plugin use github github_diff --repo Weavetab/Weavetab --pull_number 42

# Print the bounded AGENTS.md playbook for a plugin
weavetab plugin agents github
```

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
| `[P]` | List installed Weavetab plugins |
| `[R]` | Purge browser profiles and lockfiles |
| `[H]` | Show help information |
| `[G]` / `[N]` / `[W]` | Open GitHub / npm / website links |
| `[Q]` | Exit Weavetab |
