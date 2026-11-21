---
title: "Security Model"
description: "Layered defenses that gate every tool invocation."
product: mcp
section: architecture
icon: ShieldCheck
slug: security
---

# Security Model

Weavetab executes direct CDP commands — security is layered and **deny-by-default for risky surfaces**.

## Defense-in-Depth Mechanisms

| Mechanism | Description |
|---|---|
| **Domain Blacklist** | Default and user-configurable high-risk domain blocklists (`allow` evaluated before `block`) with wildcard matching, bare-domain subdomain matching, and trailing-dot normalization. |
| **Domain Policy Engine** | Specificity-ordered per-domain enforcement modes (`allow`, `read-only`, `deny`, `audit-only`); `read-only` excludes `browser_eval` and enforces action-level read-only checks on `cookies`, `tabs`, `snapshot`, `console`, and `pattern_learn`. |
| **Localhost Binding & WS Auth** | CDP and `--ws` endpoints bound to `127.0.0.1` with per-socket shared-secret authentication (5s auth timeout), IPv6 `[::1]` host support, and `0o600` + Windows `icacls` on `ws-secret`. |
| **Rate Limiting** | Sliding-window actions-per-minute rate limiter enforced on top-level tools and `browser_burst` steps. |
| **RBAC Roles** | 5 fail-closed roles gating tool and action access (`admin`, `operator`, `viewer`, `automation`, `system`); `viewer` excludes `browser_eval` and enforces action-level read-only gating. |
| **Root Guard** | Prevents execution as root/superuser on Unix systems. |
| **Blind Injection** | Fail-closed AES-256-GCM credential injection from `secrets.json` (opt-in `WT_PROJECT_SECRETS=1` for project secrets; blocks empty-hostname URLs like `file://`/`about:blank`) with `0o600` + Windows `icacls` on `secrets.json` and `secrets-key`. |
| **Non-Destructive Capture Masking** | Inline CSS masking (`-webkit-text-security: disc; color: transparent`) during `screenshot`, `snapshot`, and `pdf` capture without clearing live input values. |
| **Recursive Output Redaction** | `SessionSecretTracker.redactValue()` recursively scrubs tracked secrets across strings, objects, arrays, delta diffs, session trails, compiled patterns, audit logs, and `eval`, `storage`, `cookies`, `clipboard`, `automation`, `console`, `find`, `snapshot`, and `office` outputs. |
| **Injection & XSS Hardening** | Strict `local`/`session` scope validation in `browser_storage`, `textContent` badge rendering + color allowlisting in `browser_highlight`, HTML escaping in HUD anchor badges, `JSON.stringify` escaping in `browser_dialog` toasts, and `{ devMode }`-only webpage config injection. |
| **Extension & Shadow DOM Isolation** | Top-frame-only MV3 HUD and cursor mounting (`window === window.top`) with origin-checked messaging and isolated Shadow DOM trees. |
| **Path, Flag & Plugin Hardening** | `realpathSync` containment on plugin entries/storage and browser profiles, `WT_ALLOW_WORKSPACE_PLUGINS=1` workspace plugin gate, manifest-only plugin permissions, dangerous browser flag stripping (`--user-data-dir`, `--remote-debugging-*`, `--disable-web-security`), Electron `XDG_CONFIG_HOME`/`XDG_DATA_HOME` isolation, and owner-only `mode: 0o600` checkpoints. |

## RBAC Role Matrix

| Tool Category | admin | operator | viewer | automation | system |
|---|:---:|:---:|:---:|:---:|:---:|
| Mutation & eval tools (`click`, `type`, `fill`, `eval`, etc.) | yes | yes | no | yes | no |
| Read-only tools (`map`, `find`, `scrape`, `inspect`, `screenshot`, `pdf`, `wait`, `detect`) | yes | yes | yes | yes | subset (`detect`) |
| Action-gated read-only (`cookies` [get/list], `tabs` [list/list_windows], `snapshot` [capture], `console` [read], `pattern_learn` [get]) | yes | yes | read-only actions | yes | subset (`pattern_learn`) |
| High-level orchestration (`burst`, `automation`) | yes | yes | no | yes | no |
| Interactive HUD (`thoughts`) | yes | yes | no | no | yes |
| System introspection (`detect`, `performance`, `checkpoint`, `pattern_learn`) | yes | yes | `detect`, `pattern_learn` [get] | yes | yes |
