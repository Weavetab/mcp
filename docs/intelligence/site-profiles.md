---
title: "Site Profiles and Intelligent Memory"
description: "Persistent cross-session workflow memory, pattern compilation, and quirk bypass in ~/.weavetab-system/memory/sites/."
product: mcp
section: intelligence
icon: Brain
slug: site-profiles
---

# Site Profiles and Intelligent Memory Engine

Every browser automation session normally starts from zero context. The agent re-inspects DOM trees, re-triggers cookie banners, and re-discovers login fields.

Weavetab solves this with a **Two-Tier Persistent Memory System** that accumulates knowledge about domains and workflows across sessions.

---

## Directory Hierarchy: System vs. User Space

| Directory | Purpose | Managed By |
| :--- | :--- | :--- |
| `~/.weavetab-system/memory/sites/` | **Persistent Site Profiles**: named workflow patterns, quirks, reliability scores | Weavetab Engine (autonomous) |
| `~/.weavetab-system/memory/` | **Selector Confidence Cache**: per-domain element selectors and strike counters | Weavetab Engine (autonomous) |
| `~/.weavetab-system/sessions/` | **Rolling Action Trails**: 50-step window for loop detection | Weavetab Engine (autonomous) |
| `~/.weavetab/` | **User Configuration**: `config.json`, `secrets.json`, `knowledge/`, plugins | User / Developer (manual) |

> **Directory Law**: Machine-compiled memory profiles are strictly located in `~/.weavetab-system/memory/sites/`. User configuration in `~/.weavetab/` is never polluted by machine learning trails or dynamic decay counters.

---

## Site Profile Schema

Profiles are stored as `<sanitized-hostname>.json` under `~/.weavetab-system/memory/sites/`:

```json
{
  "origin": "https://github.com",
  "framework": "react",
  "shadowDom": false,
  "captcha_frequency": "rare",
  "quirks": {
    "cookie_banner": {
      "selector": "#cookie-consent",
      "action": "click .accept-all",
      "appears": "first_visit"
    },
    "rate_limit": {
      "threshold": "60req/min",
      "recovery": "wait 30s"
    }
  },
  "patterns": {
    "login_flow": {
      "name": "login_flow",
      "steps": [
        { "tool": "browser_navigate", "target": "https://github.com/login" },
        { "tool": "browser_fill", "target": "#login_field", "value": "{{username}}" },
        { "tool": "browser_fill", "target": "#password", "value": "{{password}}" },
        { "tool": "browser_click", "target": "[type=submit]" }
      ],
      "success_indicator": "a[aria-label='Homepage']",
      "entry": "/login",
      "avg_duration_ms": 3200,
      "reliability": 0.96,
      "strikes": 0,
      "last_verified": "2026-09-16T08:00:00.000Z",
      "total_executions": 12,
      "successful_executions": 12
    }
  },
  "visitCount": 15,
  "updatedAt": "2026-09-16T08:00:00.000Z"
}
```

---

## The Pattern Compiler

When an agent executes an automation flow:
1. **Trail Capture**: Steps are tracked via the lightweight action trail.
2. **Selector Stabilization**: Volatile CSS hash classes (`[class*="hash-"]`), positional pseudos (`:nth-child`), and deep anonymous structural chains are filtered out. Only semantic selectors (`id`, `data-testid`, semantic attributes, roles) are persisted.
3. **Merge-on-Write**: Calling `browser_pattern_learn` updates existing patterns in place. Duplicate calls never create duplicate files or duplicate entries.
4. **Anti-Spam Guard**: If an incoming pattern is identical to stored disk state, the disk write is skipped entirely.

---

## Reliability Scoring and 3-Strike Degradation

Each pattern tracks a reliability score (`0.0` to `1.0`) computed via Exponentially Weighted Moving Average (EWMA with $\alpha = 0.15$):

$$\text{Reliability}_{t} = 0.85 \times \text{Reliability}_{t-1} + 0.15 \times (\text{Success} ? 1 : 0)$$

### Decision Thresholds

- **Fast-Path ($\ge 0.80$)**: Replay stored steps directly via `browser_burst` — skips exploratory DOM navigation entirely.
- **Cautious Replay ($0.50 - 0.79$)**: Replay steps, but verify `success_indicator` after critical steps.
- **Re-Learn ($< 0.50$ or $\ge 3$ consecutive strikes)**: Pattern is flagged `[RE-LEARN NEEDED]`. The agent falls back to fresh DOM exploration, then calls `browser_pattern_learn` to teach the updated steps.

---

## MCP Tools

### `browser_pattern_learn`
All site memory operations use a single tool. Use `action: "get"` to read a site profile, `action: "learn"` to register a workflow, `action: "record_execution"` to update reliability scores, and `action: "record_quirk"` to store site quirks:

```json
{ "tool": "get", "origin": "https://github.com" }
```

```json
{
  "origin": "https://github.com",
  "action": "learn",
  "name": "login_flow",
  "steps": [
    { "tool": "browser_click", "target": ".btn-login" },
    { "tool": "browser_fill", "target": "#login_field", "value": "{{username}}" }
  ],
  "success_indicator": "a[aria-label='Homepage']"
}
```

---

## SDK Plugin Integration (`ctx.memory`)

Plugin authors can interact with persistent site memory directly via the SDK:

```typescript
import { definePlugin } from "@weavetab/sdk";

export default definePlugin({
  name: "custom-site-automator",
  async onLoad(ctx) {
    // Read current profile
    const profile = await ctx.memory?.getSiteProfile("https://github.com");

    // Check reliability
    const reliability = await ctx.memory?.getReliability("https://github.com", "login_flow");
    if (reliability && reliability >= 0.8) {
      ctx.logger.info("Fast-path ready for login_flow");
    }

    // Teach a new pattern
    await ctx.memory?.learnPattern("https://github.com", "quick_search", {
      steps: [{ tool: "browser_fill", target: "input.header-search-input", value: "test" }]
    });
  }
});
```
