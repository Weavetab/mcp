---
title: "Security Model"
description: "Layered defenses that gate every tool invocation."
product: mcp
section: architecture
icon: ShieldCheck
slug: security
---

# Security Model

Weavetab executes direct Layer 0 CDP commands — security is layered and **deny-by-default for risky surfaces**.

## Defense-in-Depth Mechanisms

| Mechanism | Description |
|---|---|
| **Domain Blacklist** | Hard-blocked high-risk domains (banking, IAM consoles, internal infrastructure). |
| **Domain Policy Engine** | Per-domain enforcement modes: `allow`, `read-only`, `deny`, `audit`. |
| **Localhost Binding** | WebSocket server and CDP endpoints strictly bound to `127.0.0.1`. |
| **Rate Limiting** | Mutex-enforced actions-per-minute rate limiter. |
| **RBAC Roles** | 5 roles gating tool access (`admin`, `operator`, `viewer`, `automation`, `system`). |
| **Root Guard** | Prevents execution as root/superuser on Unix systems. |
| **Blind Injection** | Credential injection from `secrets.json` without exposing raw text to LLM context. |
| **Shadow DOM Isolation** | All injected HUD and modal overlays run in isolated Shadow DOM trees. |
| **Path Traversal Guard** | File upload and download paths strictly validated against path traversal. |

## RBAC Role Matrix

| Tool Category | admin | operator | viewer | automation | system |
|---|:---:|:---:|:---:|:---:|:---:|
| Mutation tools (`click`, `type`, `fill`, etc.) | yes | yes | no | yes | no |
| Read-only tools (`map`, `find`, `scrape`, `screenshot`) | yes | yes | yes | yes | no |
| High-level orchestration (`burst`, `automation`, `wait`) | yes | yes | no | yes | no |
| Interactive HUD (`thoughts`) | yes | yes | no | no | yes |
| System introspection (`detect`, `performance`, `checkpoint`) | yes | yes | no | yes | yes |
