---
title: "Config Errors"
description: "Configuration validation, secrets, and policy issues."
product: mcp
section: troubleshooting
icon: AlertTriangle
slug: trouble-config
---

# Configuration Issues

## Secrets Not Injecting

1. Check that `~/.weavetab/secrets.json` or `./.weavetab/secrets.json` exists
2. Verify the secret key name matches exactly (case-sensitive)
3. Run `weavetab secrets list` to confirm keys are registered

## Configuration Quarantined

If a config file has syntax errors, Weavetab quarantines it to `config.broken.<timestamp>.json` and falls back to defaults. Run `weavetab config` to regenerate a valid file.
