---
title: "Loop Detection"
description: "When the agent gets stuck in an action loop."
product: mcp
section: troubleshooting
icon: RotateCcw
slug: trouble-loop
---

# Loop Detection Diagnostics

## Symptoms

A tool call returns `stuck_warning: true` or `STUCK_LOOP_WARNING`.

## Cause

Weavetab tracks a rolling 50-action window in `~/.weavetab-system/sessions/context.json`. If repeated identical actions fail to produce DOM state changes, strikes are accumulated:

| Strikes | Severity | System Behavior |
|---|---|---|
| < 5 | Normal | Standard execution |
| 5–9 | Warning | Warning hint injected into agent context |
| 10+ | Critical | Agent marked as `stuck`; recovery strategy triggered |

## Resolution

1. Call `browser_map({ force: true })` or `browser_wait({ reset_loop: true })` to clear strikes
2. Call `browser_map({ delta: true })` to verify if DOM elements actually changed
3. Call `browser_inspect` to check if target element is hidden or occluded by modals
4. Use `browser_wait({ for: "stable" })` before triggering inputs
