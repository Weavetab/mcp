---
title: "Locations & Merge"
description: "Two-tier merge: global config → built-in defaults."
product: mcp
section: configuration
icon: FolderTree
slug: config-locations
---

# Config Locations & Merge Priority

## Priority Tiers

1. **Global** — `~/.weavetab/config.json` (the only config file Weavetab reads)
2. **Built-in defaults** — defined in `DEFAULT_CONFIG`

## Live Reload

A debounced file watcher (150 ms) reloads the in-memory configuration on change. In-flight tool executions complete on the existing configuration; subsequent calls automatically pick up the new values.

## Corrupt File Quarantine

If a configuration file contains invalid JSON, Weavetab automatically quarantines the file to `config.broken.<timestamp>.json` and safely falls back to the next tier without crashing.
