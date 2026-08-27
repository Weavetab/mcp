---
title: "Locations & Merge"
description: "Three-tier merge: local → global → built-in defaults."
product: mcp
section: configuration
icon: FolderTree
slug: config-locations
---

# Config Locations & Merge Priority

## Priority Tiers

1. **Local (Project-scoped)** — `./.weavetab/config.json` (takes top priority)
2. **Global** — `~/.weavetab/config.json`
3. **Built-in defaults** — defined in `DEFAULT_CONFIG`

## Live Reload

A debounced file watcher (150 ms) reloads the in-memory configuration on change. In-flight tool executions complete on the existing configuration; subsequent calls automatically pick up the new values.

## Corrupt File Quarantine

If a configuration file contains invalid JSON, Weavetab automatically quarantines the file to `config.broken.<timestamp>.json` and safely falls back to the next tier without crashing.
