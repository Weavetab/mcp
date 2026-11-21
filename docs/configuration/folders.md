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

Optional, created in your current working directory (`weavetab secrets init --project`) to carry project-scoped credentials alongside a checkout (loaded when `WT_PROJECT_SECRETS=1` is set):

```
./.weavetab/
└── secrets.json         # Project-scoped credentials for Blind Injection (0o600 + Windows icacls)
```

Keys in a project `secrets.json` take precedence over `~/.weavetab/secrets.json` when `WT_PROJECT_SECRETS=1` is enabled. All other configuration and output paths are global (see below) unless overridden via config fields.

## 2. Global User Directory: `~/.weavetab/`

Global, user-authored configuration and default output directories:

```
~/.weavetab/
├── config.json          # Global configuration (domain policies, roles, output paths)
├── secrets.json         # Global secrets for Blind Injection (0o600 + Windows icacls)
├── knowledge/           # Domain-specific markdown knowledge hints (deduplicated, 20-line cap)
├── plugins/             # Isolated storage directories for installed plugins (realpathSync contained)
├── downloads/           # Downloaded files (default output dir)
├── pdfs/                # Exported PDF documents
├── snapshots/           # Screenshots and MHTML snapshots
└── recordings/          # Screen recordings (webp / gif / webm / mp4)
```

Each output directory (`downloads`, `pdfs`, `snapshots`, `recordings`) is overridable via its matching config path field.

## 3. System Intelligence Directory: `~/.weavetab-system/`

Machine-managed, cross-session state. Strictly separate from user configuration:

```
~/.weavetab-system/
├── memory/                    # Per-domain selector confidence cache (50-entry cap)
│   └── sites/                 # Persistent site profiles: workflows, quirks & reliability scores
├── sessions/
│   └── context.json           # Rolling 50-action trail for loop detection (secret-redacted)
├── checkpoints/               # Named browser-state checkpoints (0o600)
├── missions/                  # Mission state files
├── apps/                      # Dedicated isolated profiles for Electron apps (XDG isolated)
├── cache/
│   └── update_check.json      # Cached CLI/npm update check metadata
├── extension/                 # Installed browser extension build
├── logs/                      # Mission logs: mission_<timestamp>.log / .jsonl (retains latest 30)
├── locks/                     # Atomic process lockfiles (.weavetab.lock & .weavetab.electron.<app>.lock)
├── secrets-key                # Local AES-256-GCM key for stored secrets (0o600 + Windows icacls)
├── stats.json                 # Local telemetry counters (when telemetry: true)
├── telemetry-secret           # Local anonymous telemetry salt (0o600 + Windows icacls)
├── ws-secret                  # 256-bit shared-secret Bearer token for --ws daemon auth (0o600 + Windows icacls)
└── session-profile*/          # Isolated Chromium browser profiles (never your real profile)
```
