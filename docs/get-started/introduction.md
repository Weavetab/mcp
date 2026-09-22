---
title: "Introduction"
description: "What Weavetab is, Layer 0 CDP architecture, and design tenets."
product: mcp
section: get-started
icon: BookOpen
slug: introduction
---

# Introduction

Weavetab is a production-grade, local **Model Context Protocol (MCP) server** that grants AI agents human-like control over Chromium browsers and native **Electron desktop applications** (VS Code, Discord, Slack, Figma, Obsidian, Postman, Antigravity IDE, etc.) — communicating directly over the **Chrome DevTools Protocol (CDP)** at Layer 0.

No WebDriver. No browser binary downloads. No Playwright or Puppeteer abstraction layer. No cloud dependency. Tool invocations resolve in **3–8 ms** of mean latency.

## Synchronized Ecosystem Releases

Both **`@weavetab/mcp`** and the **`@weavetab/sdk`** share synchronized release lines. Every capability introduced in the core runtime is immediately available in the developer SDK with 100% type safety and zero version mismatch.

```bash
# Install core Weavetab MCP server globally
npm install -g @weavetab/mcp@latest

# Or run directly via npx
npx -y @weavetab/mcp@latest

# Install Weavetab Developer SDK as a dev dependency
npm install -D @weavetab/sdk@latest
```

## Design Tenets

| Tenet | Implementation |
|---|---|
| **Ultra-Low Latency** | Sub-10 ms tool execution via direct CDP WebSocket connections |
| **Universal Control** | Native orchestration across Chromium web tabs and any Electron desktop app |
| **Autonomous CAPTCHA** | Zero-API solving (Cloudflare Turnstile, GeeTest, reCAPTCHA) via human Bézier mouse physics |
| **Security & RBAC** | 4-tier RBAC + domain policies + Blind Credential Injection + profile isolation |
| **Token Efficiency** | Semantic Delta diffing (up to 97% reduction) + intelligent DOM pruning |
| **Stealth & Physics** | Ghost Cursor (Bézier curves), human typing jitter, and CDP early-script fingerprint spoofing |
| **Self-Learning** | Per-domain session memory, framework detection, and automated loop recovery |
| **Zero Cloud** | Pure local computation. No external telemetry or cloud tracking unless explicitly opted in |

## What You Get

- **50 built-in MCP tools** covering DOM vision, input synthesis, desktop apps, tabs, network interception, office files, design extraction, and plugin lifecycle
- **Universal Desktop App Runtime** — control Chrome and native Electron apps (Discord, Figma, VS Code) side-by-side without port conflicts
- **Autonomous Zero-API CAPTCHA Solver** — solve Cloudflare Turnstile, GeeTest, and reCAPTCHA locally via CDP mouse physics with $0 API costs
- **Two transport modes** — stdio (Claude Desktop, Cursor, VS Code, Windsurf, Antigravity) and WebSocket (`--ws --port 3000`)
- **Four RBAC roles** — `admin`, `operator`, `viewer`, and `automation`
- **Per-domain policies** — ring-fences sensitive banking, internal, and production surfaces
- **Blind Injection** — credentials resolved server-side from `secrets.json` and never exposed to the LLM
- **Extensible Plugin System** — auto-discovers and mounts custom MCP tools from `node_modules`

## Next Steps

- **[Quickstart](quickstart.md)** — install and run a first mission in 60 seconds
- **[Desktop & Electron Apps](../desktop-automation/electron-apps.md)** — configure and control desktop apps
- **[Autonomous CAPTCHA Solver](../captcha-stealth/captcha-solver.md)** — zero-API anti-bot solving
- **[MCP Tools Reference](../tools/tools.md)** — full reference for all 50 built-in automation tools
