---
title: "Blind Injection"
description: "Enterprise-grade credential injection that never exposes secrets to the LLM."
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
- Secrets are stored encrypted with AES-256-GCM via `weavetab secrets set <KEY>`.
- The agent passes the key name (`envKey: "MY_KEY"`), never the plaintext value.
- Domain scoping validates that the active tab's hostname matches the secret's allowed domains before any value is read from disk.
- Injection bypasses standard paste or readback mechanisms and writes directly via atomic CDP events.

### 2. Universal Element Selector Resolution
`browser_type_secret` supports:
- Direct CSS Selectors (e.g. `id: "#password"`, `id: "input[type='password']"`, `id: ".pwd-field"`)
- Element ActionMap IDs (e.g. `id: "w:5"` or `id: "5"`)
- Focused Active Element (`target: "focused"`)

### 3. DOM Property & Coercion Hardening
Upon injection or typing into any sensitive input:
- `data-wt-secret="true"` is attached to the DOM node.
- The element's `.value` getter is overridden at the instance level to return `"[REDACTED]"`.
- `Symbol.iterator`, `Symbol.toPrimitive`, and `toJSON` are overridden to prevent leakages via array spreads, template literals, or JSON serialization.

### 4. Cross-Tool Containment Matrix

| Tool | Protection Mechanism |
|---|---|
| `browser_type_secret` | In-process secret resolution, domain check, atomic CDP typing. |
| `browser_type` | Broad secret detection (`type`, `name`, `id`, `autocomplete`, `aria-label`); disables value readbacks and redactions in action logging. |
| `browser_fill` | Auto-registers secret fields in both single and `blast_mode`; masks values as `[REDACTED]` in return results and scan discovery mode (`scan: true`). |
| `browser_map` | DOM and Accessibility (AX) tree walkers redact values, placeholders, and labels for all sensitive fields. |
| `browser_scrape` | Evaluates in-page attribute extraction with automatic `[REDACTED]` substitution; filters live properties. |
| `browser_screenshot` | Applies dynamic security masking (`webkitTextSecurity: disc` / blanking) during capture and restores safely in `finally`. |
| `browser_snapshot` | Pre-masks all secret fields before MHTML export. |
| `browser_pdf` | Masks sensitive inputs during PDF generation. |

## CLI Usage

```powershell
# Store an encrypted secret with domain scoping
weavetab secrets set GITHUB_TOKEN

# List stored keys (never prints values)
weavetab secrets list

# Remove a stored key
weavetab secrets rm GITHUB_TOKEN
```

## Agent Tool Invocation

```json
{
  "id": "#password",
  "envKey": "GITHUB_TOKEN"
}
```
