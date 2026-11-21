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

Runs **before any page JavaScript executes** (deduplicated per session via a `WeakSet` and short-circuited when `headless: true`). Handles:
- **Stealth patches**: `navigator.webdriver` → `undefined`, fake plugin arrays, WebGL/Canvas fingerprint noise
- **Shadow DOM bootstrap**: `#weavetab-root` host container created in every page
- **Sanitized config binding**: `window.__wt_setConfig({ devMode })` exposes only the boolean `devMode` flag to page context

## 2. Manifest V3 Extension

Loaded dynamically with `--load-extension=${extPath}`. Mounts exclusively in the top frame (`window === window.top`) with origin-checked HUD `postMessage` and owns:
- **Ghost Cursor animation** (Bézier curve path rendering via canvas overlay, rAF loop paused when idle/hidden)
- **Thought bubble HUD** (agent status messages with HTML-escaped anchor badges during tool execution)
- **Interactive Ask Modal** (user interaction with response queue)
- **SPA navigation persistence** — survives framework router transitions without flashing
