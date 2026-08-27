---
title: "Environment Variables"
description: "Runtime environment variables that override config."
product: mcp
section: configuration
icon: Variable
slug: env-variables
---

# Environment Variables

| Variable | Description |
|---|---|
| `CHROME_PATH` | Absolute path to Chromium/Chrome binary |
| `WEAVETAB_CONFIG` | Path to a custom config file |
| `WEAVETAB_ROLE` | Override RBAC role at runtime (`admin`, `operator`, `viewer`, `automation`) |
| `WEAVETAB_DEV` | Set to `1` to enable verbose CDP dev logging |
| `WT_AGENT_ID` | Override the auto-generated agent UUID |
| `WT_PROXY_URL` | Set outbound HTTP/SOCKS proxy server URL |
