---
title: "Folder Hierarchy"
description: ".weavetab and .weavetab-system directory structure."
product: mcp
section: configuration
icon: FolderOpen
slug: folders
---

# Workspace & System Directories

Weavetab strictly partitions project-scoped credentials, global user configuration, and machine-managed system intelligence into dedicated directory structures.

## 1. Project-Scoped Directory: `./.weavetab/`

Optional, created in your current working directory to carry project-scoped credentials alongside a checkout:

```
./.weavetab/
└── secrets.json         # Project-scoped credentials for Blind Injection (override the global file)
```

Keys in a project `secrets.json` take precedence over `~/.weavetab/secrets.json` when Weavetab runs from that directory. All other configuration and output paths are global (see below) unless overridden via config fields.

## 2. Global User Directory: `~/.weavetab/`

Global, user-authored configuration and default output directories:

```
~/.weavetab/
├── config.json          # Global configuration (domain policies, roles, output paths)
├── secrets.json         # Global secrets for Blind Injection
├── knowledge/           # Domain-specific markdown knowledge hints
├── plugins/             # Isolated storage directories for installed plugins
├── downloads/           # Downloaded files (default output dir)
├── pdfs/                # Exported PDF documents
├── snapshots/           # Screenshots and MHTML snapshots
├── recordings/          # Screen recordings (webp / gif / webm / mp4)
└── designs/             # Extracted design tokens and Tailwind themes
```

Each output directory (`downloads`, `pdfs`, `snapshots`, `recordings`, `designs`) is overridable via its matching config path field.

## 3. System Intelligence Directory: `~/.weavetab-system/`

Machine-managed, cross-session state. Strictly separate from user configuration:

```
~/.weavetab-system/
├── memory/                    # Per-domain selector confidence cache
│   └── sites/                 # Persistent site profiles: workflows, quirks & reliability scores
├── sessions/
│   └── context.json           # Rolling action trail for loop detection
├── checkpoints/               # Named browser-state checkpoints
├── missions/                  # Mission state files
├── apps/                      # Dedicated isolated profiles for Electron apps
├── extension/                 # Installed browser extension build
├── logs/                      # Mission logs: mission_<timestamp>.log / .jsonl (devMode only)
├── locks/                     # Process lockfiles (PID + TCP port validation)
├── secrets-key                # Local key used to encrypt stored secrets
└── session-profile*/          # Isolated Chromium browser profiles (never your real profile)
```
