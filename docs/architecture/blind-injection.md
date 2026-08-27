---
title: "Blind Injection"
description: "Enterprise-grade credential injection that never exposes secrets to the LLM."
product: mcp
section: architecture
icon: Lock
slug: blind-injection
---

# Blind Injection

The `browser_type_secret` tool resolves passwords, tokens, and 2FA credentials directly from `secrets.json` on the server — **never exposing sensitive values to the AI model's context stream**.

## How It Works

1. Store a secret via `weavetab secrets set MY_KEY` or by editing `secrets.json`
2. The agent calls `browser_type_secret({ id: "w:2", envKey: "MY_KEY" })`
3. Weavetab resolves the secret from `secrets.json` in-process on the local machine
4. The value is typed directly into the DOM input field over CDP
5. All subsequent `browser_map` outputs, DOM snapshots, and audit logs permanently display `[REDACTED]` for that element
