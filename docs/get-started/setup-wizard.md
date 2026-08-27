---
title: "Setup Wizard"
description: "Interactive wizard that writes a clean config.json."
product: mcp
section: get-started
icon: Wand2
slug: setup-wizard
---

# Setup Wizard

Run the interactive CLI configuration wizard:

```bash
weavetab config
```

The wizard walks through every option across 5 interactive phases. Re-run it at any time to update your saved config.

## Wizard Phases

1. **Phase 1 — Essentials:** Browser path, RBAC role (`admin`, `operator`, `viewer`, `automation`), headless mode, dev mode, max tabs, actionability timeout, domain block/allow lists.
2. **Phase 2 — Advanced:** Browser engine selection, navigation timeouts, dark mode preferences, telemetry opt-in, outbound HTTP/SOCKS proxy, domain policy modes.
3. **Phase 3 — Save Location:** Global (`~/.weavetab/config.json`) or Project-scoped (`./.weavetab/config.json`).
4. **Phase 4 — MCP Auto-Config:** Auto-detects installed IDEs (Claude Desktop, Cursor, Windsurf, VS Code, OpenCode, Claude Code, Antigravity) and merges Weavetab into their MCP configuration.
5. **Phase 5 — Summary:** Displays full configuration validation report.
