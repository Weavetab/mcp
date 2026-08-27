---
title: "Folder Hierarchy"
description: ".weavetab, .weavetab-system, and ~/.weavetab directory structure."
product: mcp
section: configuration
icon: FolderOpen
slug: folders
---

# Workspace & System Directories

Weavetab strictly partitions project-scoped output, global configurations, and system-level intelligence data into dedicated directory structures.

## 1. Project-Scoped Directory: `./.weavetab/`

Created in your current working directory to store project-scoped settings and mission output:

```
./.weavetab/
├── config.json          # Project-specific config overrides
├── secrets.json         # Project-scoped credentials for Blind Injection
├── pdfs/                # Exported PDF documents
├── screenshots/         # Full-page and clipped PNG/JPEG screenshots
├── downloads/           # Downloaded files during automated sessions
├── designs/             # Extracted design tokens and Tailwind themes
└── logs/                # Human-readable logs and JSONL audit trails
```

## 2. System Intelligence Directory: `~/.weavetab-system/`

Global system directory holding cross-session learning and process locks:

```
~/.weavetab-system/
├── memory/                    # Per-domain frontend framework & strategy profiles
├── sessions/
│   └── context.json           # Rolling 50-action trail for loop detection
├── apps/                      # Dedicated user profiles for Electron apps
├── locks/                     # Process lockfiles (PID + TCP port validation)
└── knowledge/                 # Domain-specific markdown knowledge hints
```

## 3. Global User Directory: `~/.weavetab/`

Global user directory storing default configurations and global secrets:

```
~/.weavetab/
├── config.json          # Global default configuration
├── secrets.json         # Global secrets for Blind Injection
├── policy.json          # Domain whitelist / blacklist rules
├── plugins/             # Isolated storage directories for installed plugins
└── profile/             # Dedicated default Chromium browser profile
```
