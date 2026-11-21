---
title: "Blind Injection"
description: "Host-isolated credential injection that never exposes secrets to the LLM."
product: mcp
section: architecture
icon: Lock
slug: blind-injection
---

# Blind Injection & Secret Containment

The `browser_type_secret` tool and automated secret detection engine resolve passwords, tokens, API keys, PINs, and credentials directly from encrypted storage on the local host — **ensuring sensitive values never cross into the AI agent's context stream or tool outputs**.

## Core Architecture

```
[Encrypted secrets.json]
         │
         ▼ (In-process resolution & domain validation)
[Weavetab Server]
         │
         ▼ (Atomic CDP Input.insertText / ghostType)
[Chromium Target Field]
         │
         ├─► DOM Property Hardening (getter override, symbol coercion, toJSON)
         ├─► In-Memory SessionSecretTracker (backendNodeId & text redaction)
         └─► Dynamic Visual Masking (screenshot, snapshot, PDF blanking)
```

## Multi-Layer Containment Mechanisms

### 1. Zero-Exposure Injection
- Secrets are stored encrypted with fail-closed AES-256-GCM via `weavetab secrets set <KEY>` (`0o600` permissions + Windows `icacls` ACLs on `secrets.json` and `secrets-key`; project `./.weavetab/secrets.json` is opt-in via `WT_PROJECT_SECRETS=1`).
- The agent passes the key name (`envKey: "MY_KEY"`), never the plaintext value.
- Domain scoping normalizes trailing FQDN dots, validates that the active tab's hostname matches the secret's allowed domains before any value is decrypted, and blocks empty-hostname URLs (`file://`, `about:blank`).
- Injection bypasses standard paste or readback mechanisms and writes directly via atomic CDP events.

### 2. Universal Element Selector Resolution
`browser_type_secret` supports:
- Direct CSS Selectors (e.g. `id: "#password"`, `id: "input[type='password']"`, `id: ".pwd-field"`)
- Exact ActionMap Ref IDs (e.g. `id: "w:5"`)
- Focused Active Element (`target: "focused"`)

### 3. DOM Property & Coercion Hardening
Upon injection or typing into any sensitive input:
- `data-wt-secret="true"` is attached to the DOM node.
- The element's `.value` getter is overridden at the instance level to return `"[REDACTED]"`.
- `Symbol.iterator`, `Symbol.toPrimitive`, and `toJSON` are overridden to prevent leakages via array spreads, template literals, or JSON serialization.

### 4. Cross-Tool Containment Matrix

| Tool | Protection Mechanism |
|---|---|
| `browser_type_secret` | In-process secret resolution, strict domain check (blocks `file://`/`about:blank`), exact ref matching, atomic CDP typing, HUD cleanup in `finally`. |
| `browser_type` | Broad secret detection (`type`, `name`, `id`, `autocomplete`, `aria-label`); disables value readbacks and redactions in action logging. |
| `browser_fill` | Auto-registers secret fields in both single and `blast_mode`; masks values as `[REDACTED]` in return results and scan discovery mode (`scan: true`). |
| `browser_map` | DOM and Accessibility (AX) tree walkers redact values, placeholders, and labels for all sensitive fields. |
| `browser_scrape` | Evaluates in-page attribute extraction with automatic `[REDACTED]` substitution; filters live properties across initial and retry passes. |
| `browser_eval` | Recursively redacts tracked secrets via `SessionSecretTracker.redactValue()` across returned strings, objects, and arrays. |
| `browser_storage` | Redacts tracked secrets on `get` and `list` (with a 2,000-char value cap on `list`). |
| `browser_cookies` | Redacts tracked secret values on `get` / `list`. |
| `browser_clipboard` | Redacts tracked secrets on `read`. |
| `browser_automation` | Recursively redacts polled mailbox results via `redactValue()`. |
| `browser_console` | Redacts secrets across buffered console messages (capped at 1,000 chars per entry). |
| `browser_find` | Redacts tracked secrets from matched element labels. |
| `browser_office` | Redacts tracked secrets in extracted document text and tabular rows. |
| `browser_screenshot` | Applies non-destructive inline CSS masking (`-webkit-text-security: disc !important; color: transparent !important;`) during capture and restores original styles in `finally` without clearing live input values. |
| `browser_snapshot` | Pre-masks secret fields via non-destructive CSS masking and redacts tracked secrets inside saved MHTML payloads. |
| `browser_pdf` | Applies non-destructive CSS masking to sensitive inputs during PDF generation. |
| **Delta, Trail, Patterns & Logs** | `SessionSecretTracker` redacts tracked secrets across DOM delta diffs (`RefEntry` labels/values), session trail history (`input`/`result`/`url`), compiled patterns (`step.value`/`step.extra`), and audit logs. |

## CLI Usage

```powershell
# Store an encrypted password or 2FA secret with domain scoping
weavetab secrets set ACCOUNT_PASSWORD

# List stored keys (never prints values)
weavetab secrets list

# Remove a stored key
weavetab secrets rm ACCOUNT_PASSWORD
```

## Agent Tool Invocation

```json
{
  "id": "#password",
  "envKey": "ACCOUNT_PASSWORD"
}
```
