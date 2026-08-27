---
title: "Dual Injection"
description: "CDP early-script + Manifest V3 extension working in tandem."
product: mcp
section: architecture
icon: Combine
slug: dual-injection
---

# Dual Injection Strategy

Weavetab delivers overlay UI and stealth capabilities through **two complementary channels** that cover each other's blind spots.

## 1. CDP Early-Script Injection

```typescript
await session.Page.addScriptToEvaluateOnNewDocument({ source: STEALTH_SCRIPT });
await session.Runtime.evaluate({ expression: STEALTH_SCRIPT }).catch(() => {});
```

Runs **before any page JavaScript executes**. Handles:
- **Stealth patches**: `navigator.webdriver` → `undefined`, fake plugin arrays, WebGL/Canvas fingerprint noise
- **Shadow DOM bootstrap**: `#weavetab-root` host container created in every page
- **Config binding**: `window.__wt_setConfig`, `window.__wt_config` for live runtime updates

## 2. Manifest V3 Extension

Loaded dynamically with `--load-extension=${extPath}`. Owns:
- **Ghost Cursor animation** (Bézier curve path rendering via canvas overlay)
- **Thought bubble HUD** (agent status messages during tool execution)
- **Interactive Ask Modal** (user interaction with response queue)
- **SPA navigation persistence** — survives framework router transitions without flashing
