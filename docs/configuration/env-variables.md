---
title: "Environment Variables"
description: "Runtime environment variables that override config."
product: mcp
section: configuration
icon: Variable
slug: env-variables
---

# Environment Variables

Only these two are read at runtime (`MCP/src/config/loader.ts`). Everything else
(browser path, role, headless, dev mode) lives in `~/.weavetab/config.json`
— run `weavetab config` to change it.

| Variable | Description |
|---|---|
| `WT_AGENT_ID` | Override the auto-generated agent UUID |
| `WT_PROXY_URL` | Set outbound HTTP/SOCKS proxy server URL |
