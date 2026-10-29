---
title: "Overview"
description: "Five layers, deterministic pipeline, zero cloud."
product: mcp
section: architecture
icon: Layers
slug: overview
---

# Architecture Overview

Weavetab is decomposed into **five functional layers**, all running in-process without external daemon dependencies.

## Layer Map

| # | Layer | Responsibility |
|---|---|---|
| 1 | **Transport** | JSON-RPC 2.0 over stdio (default) or WebSocket (`--ws --port 3000`) |
| 2 | **Security & Governance** | Domain blacklist, rate limiter (mutex), RBAC roles, policy engine, root guard |
| 3 | **Intelligence Engine** | Session memory, semantic delta diffing, DOM pruner, loop detection, intent intercept |
| 4 | **Sensor Systems** | Network telemetry, DOM mutation observer, human pacing, agent state machine |
| 5 | **CDP Bridge** | DOM walker, Ghost Cursor (Bézier trajectories), keystroke engine, shadow-DOM injector |

## Tool Execution Pipeline

```text
Agent → withSecurity()
        ├── Rate limiter (mutex)
        ├── Domain policy check (allow/deny/audit/read-only)
        ├── RBAC role verification
        ├── User-stop polling
        ├── Chat queue draining
        ├── Agent state transition (idle → weaving → reading)
        └── Tool handler → CDP Bridge → Browser / Desktop App
```

Any validation or security failure short-circuits the pipeline immediately and returns a structured `WeaveError` — no partial side-effects are left on the browser.

## Why Direct CDP

| Feature | Weavetab | Playwright | Puppeteer | Selenium |
|---|---|---|---|---|
| **Architecture** | Direct CDP WebSocket | Node bridge abstraction | CDP wrapper | WebDriver |
| **Execution model** | **In-process local socket** | IPC binary bridge | IPC binary bridge | HTTP WebDriver relay |
| **Token efficiency** | **Semantic Deltas (97% reduction)** | Full DOM dumps | Full DOM dumps | Full DOM dumps |
| **Desktop Electron Apps** | **Native (any Electron app)** | Experimental | Limited | Third-party driver |
| **CAPTCHA Solver** | **Autonomous Zero-API** | None | None | None |
| **MCP native** | **Yes (41 Tools)** | No | No | No |
| **Cloud dependency** | **Zero** | Optional | Optional | Grid required |
