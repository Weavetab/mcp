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

The wizard walks through every option across 6 interactive phases. Re-run it at any time to update your saved config.

## Wizard Phases

1. **Phase 1 — Essentials:** Browser path, RBAC role (`admin`, `viewer`, `automation`), headless mode, dev mode, max tabs, actionability timeout, domain block/allow lists.
2. **Phase 2 — Advanced (optional):** Browser engine selection, timeouts and rate limits, telemetry opt-in, download/proxy directories, domain policy entries.
3. **Phase 3 — Save Location:** Global (`~/.weavetab/config.json`).
4. **Phase 4 — MCP Auto-Config:** Auto-detects installed IDEs (Claude Desktop, Cursor, Windsurf) and merges Weavetab into their MCP configuration.
5. **Phase 5 — Agent Skills:** Optionally installs `@weavetab/skills` for your agent framework.
6. **Phase 6 — Summary:** Displays full configuration validation report.
