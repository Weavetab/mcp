---
title: "Browser Issues"
description: "CDP connection failures, crashes, and extension problems."
product: mcp
section: troubleshooting
icon: MonitorX
slug: trouble-browser
---

# Browser Connection Issues

## "CDP connection failed" Error

**Causes:**
- Port 9222 is occupied by another process
- Chrome was launched without `--remote-debugging-port`

**Fixes:**
1. Run `weavetab reset --yes` to terminate orphaned browser processes
2. Verify port availability: `netstat -an | grep 9222`
3. Restart Weavetab

## Browser Crashes on Launch

**Fixes:**
1. Run `weavetab reset` to purge corrupted profiles
2. Run `weavetab config` and set the browser executable path (or `browserPath: "auto"` to detect)
