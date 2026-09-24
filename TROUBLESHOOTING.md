# Weavetab MCP Troubleshooting Guide

> **Version:** 2.5.0 (Beta) | **Package:** `@weavetab/mcp` | **Last Updated:** August 2026

This guide covers common issues and their solutions when working with Weavetab's MCP tools.

---

## Table of Contents

- [Common Issues](#common-issues)
- [Configuration Issues](#configuration-issues)
- [Browser Connection Issues](#browser-connection-issues)
- [Performance Issues](#performance-issues)
- [Security Issues](#security-issues)
- [Debugging Tips](#debugging-tips)

---

## Common Issues

### 1. `browser_map` returns "skipped: true" permanently

**Symptom:** `browser_map` consistently returns a JSON object with `skipped: true` and refuses to map the page, citing a `w:NN` ref that doesn't exist on the current page.

**Cause:** Weavetab's "smart skip" logic prevents wasting tokens on duplicate maps if the DOM hasn't changed. However, cross-session stale state on disk can poison this detection.

**Solutions:**
- Pass `force: true` to `browser_map` to force a rebuild
- Navigate to a new page (which clears the URL-specific skip lock)
- Clear the cache: `Weavetab reset` to clear all session state

**Example:**
```typescript
browser_map({ force: true })
```

---

### 2. `browser_fill` reports "0 succeeded" but the fields actually changed

**Symptom:** The tool fills the form perfectly, but the MCP tool response says the fields failed to apply.

**Cause:** (Fixed in v2.5.0+) Previously, verification was backwards. If you see this in older versions, upgrade to the latest version.

**Solution:** None needed on v2.5.0+. The verification logic correctly compares pre-mutation and post-mutation state.

---

### 3. `browser_type` appends text instead of replacing it

**Symptom:** When trying to type "NEW VALUE" into a field containing "Jane", the field becomes "JaneNEW VALUE".

**Cause:** The auto-clear logic relies on keyboard shortcuts (Ctrl+A, Delete) which can fail if the element loses focus during the split-second execution.

**Solution:** (Fixed in v2.5.0+) Auto-clear now uses atomic JavaScript evaluation to clear fields securely before typing. For older versions, use `clearFirst: true` parameter.

**Example:**
```typescript
browser_type({ id: "w:1", text: "NEW VALUE", clearFirst: true })
```

---

### 4. `browser_select` reports success but the value immediately reverts

**Symptom:** The dropdown changes, but immediately snaps back to the old value, yet the tool reports `success: true`.

**Cause:** Frameworks like React and Vue control form state asynchronously. If Weavetab checks too quickly, it sees the changed DOM before React overrides it.

**Solution:** The tool now implements a 400ms multi-pass verification window for dropdowns to detect asynchronous reversion. If the issue persists, try using `browser_fill` with a small delay.

---

### 5. `browser_click` by label takes 50+ seconds

**Symptom:** `browser_click({ label: "Submit" })` works, but the command hangs for nearly a minute before returning.

**Cause:** Clicking by label requires a full DOM scan. If the click triggers a navigation, older versions would synchronously rebuild the heavy DOM map of the *new* page before returning.

**Solutions:**
- **Best Practice:** Always use `ref` IDs (`w:42`) from `browser_map` rather than text labels
- **Fixed in v2.5.0+:** Label clicks now use an LRU cache, and post-navigation DOM mapping is deferred

**Example:**
```typescript
// Get fresh refs
const map = await browser_map()
// Use ref instead of label
browser_click({ id: "w:42" })
```

---

### 6. `browser_inspect` returns `null` for boxModel or styles

**Symptom:** Inspecting an element returns `null` for its box model, preventing layout debugging.

**Cause:** The CDP query fired before the browser finished painting the layout.

**Solution:** The tool now automatically waits 100ms for layout settling and retries up to 3 times. If the issue persists, manually add a small delay before inspection.

---

### 7. `stuck_warning` fires but the page clearly changed

**Symptom:** The tool reports `stuck_warning: true`, but the visual page or text labels visibly changed.

**Cause:** The warning previously relied on strict text matching.

**Solution:** `stuck_warning` now respects the underlying `delta` computation. If the DOM changed, the warning will not fire. If you still see false positives, use `browser_map({ force: true })` or `browser_wait({ reset_loop: true })` to manually reset.

---

### 8. Extension not loading in headless mode

**Symptom:** The Weavetab extension features (HUD, Voice UI, etc.) don't appear in headless mode.

**Cause:** Chrome extensions don't load in headless mode by default.

**Solution:** Use headed mode (`headless: false` in config) or use the `--headless=new` Chrome flag which supports some extension features.

---

## Configuration Issues

### 1. Domain blacklist not working

**Symptom:** Weavetab allows navigation to blacklisted domains.

**Cause:** Domain blacklist configuration may not be loaded correctly.

**Solution:**
- Verify `~/.Weavetab/policy.json` exists and is valid JSON
- Check that the domain pattern matches (wildcards use `*` not regex)
- Restart Weavetab after modifying policy.json

**Example policy.json:**
```json
{
  "policies": [
    {
      "pattern": "*.banking.com",
      "mode": "deny"
    }
  ]
}
```

---

### 2. RBAC permissions not enforced

**Symptom:** Restricted roles can access tools they shouldn't.

**Cause:** Role configuration may not be set correctly.

**Solution:**
- Verify `role` is set in `~/.Weavetab/config.json`
- Check that the role is one of: `admin`, `system`, `viewer`, `automation`
- Restart Weavetab after changing roles

---

### 3. Secrets not being injected

**Symptom:** `browser_type_secret` fails to find the secret.

**Cause:** Secrets file may not exist or key may be misconfigured.

**Solution:**
- Verify `~/.Weavetab/secrets.json` exists
- Check that the key matches exactly (case-sensitive)
- For project-scoped secrets, verify `./.Weavetab/secrets.json` exists
- Use `Weavetab secrets list` to verify keys are registered

---

## Browser Connection Issues

### 1. "CDP connection failed" error

**Symptom:** Weavetab cannot connect to Chrome.

**Cause:** Chrome may not be running with remote debugging enabled, or another process is using the CDP port.

**Solution:**
- Start Chrome with remote debugging: Check if Chrome is running and listening on the expected port
- Check if another Weavetab instance is running and bound to the port
- Check Weavetab logs for port conflicts and restart
- Verify port 9222 is not in use: `netstat -an | grep 9222` (Linux/macOS) or `netstat -an | findstr 9222` (Windows)

---

### 2. Browser crashes on startup

**Symptom:** Chrome crashes immediately when Weavetab tries to connect.

**Cause:** Extension incompatibility or corrupted Chrome profile.

**Solution:**
- Try running without extension: Set `"extension": false` in config
- Use a fresh Chrome profile: Set `profileDir` to a new directory
- Check Chrome version compatibility (requires Chrome 90+)
- Disable hardware acceleration in Chrome settings

---

### 3. Multiple browser instances conflict

**Symptom:** Weavetab connects to wrong Chrome instance or fails to connect.

**Cause:** Multiple Chrome instances with remote debugging enabled.

**Solution:**
- Use different CDP ports for each instance
- Specify port in Weavetab config: `cdpPort: 9223`
- Close other Chrome instances before starting Weavetab

---

## Performance Issues

### 1. High memory usage

**Symptom:** Weavetab process consuming excessive memory (>500MB).

**Cause:** Large DOM caches or memory leaks in long-running sessions.

**Solution:**
- Clear cache: `Weavetab reset`
- Reduce `maxActionsPerMinute` to slow down execution
- Enable `prune: true` in `browser_map` to reduce cache size
- Restart Weavetab periodically for long-running sessions

---

### 2. Slow tool execution

**Symptom:** Tools taking longer than expected (>100ms).

**Cause:** Network latency, large DOM trees, or slow CDP responses.

**Solution:**
- Use `delta: true` in `browser_map` to avoid full DOM walks
- Enable `prune: true` to reduce DOM size
- Use `fast: true` in click operations for faster execution
- Check network connection and Chrome performance

---

### 3. Token usage too high

**Symptom:** LLM context filling up quickly with DOM data.

**Cause:** Full DOM maps on every read.

**Solution:**
- Use `browser_map({ delta: true, prune: true })` for maximum efficiency
- Use `browser_find` instead of `browser_map` for text searches
- Use `browser_scrape` for targeted data extraction
- Reduce `limit` parameter in `browser_map` for smaller results

---

## Security Issues

### 1. Secrets appearing in logs

**Symptom:** Sensitive data visible in audit logs.

**Cause:** Using `browser_type` instead of `browser_type_secret`.

**Solution:**
- Always use `browser_type_secret` for credentials
- Verify secrets are properly masked in logs as `[REDACTED]`
- Check that `secrets.json` has correct permissions (`chmod 600`)

---

### 2. Domain policy not blocking sensitive sites

**Symptom:** Can navigate to domains that should be blocked.

**Cause:** Policy not configured or pattern doesn't match.

**Solution:**
- Verify policy.json syntax and patterns
- Use `*.domain.com` pattern for subdomain matching
- Restart Weavetab after policy changes
- Check audit logs to see if policy is being evaluated

---

## Debugging Tips

### Enable DevMode

Set `devMode: true` in `~/.Weavetab/config.json` to see:

- Real-time tool execution timing
- Token usage estimates
- Detailed error messages
- HUD overlay in browser

### Check Audit Logs

Review `~/.Weavetab/logs/audit.log` for:

- Tool invocation history
- Error messages and stack traces
- Domain policy violations
- Security events

### Use Verbose Logging

Set environment variable for verbose output:

```bash
DEBUG=weavetab:* Weavetab
```

### Manual Browser Inspection

Connect to Chrome DevTools directly:

1. Start Chrome with remote debugging
2. Navigate to `chrome://inspect`
3. Click "inspect" on the target page
4. Use DevTools to manually inspect DOM and network



## General Fallbacks

If a tool fails:

1. **Always use `browser_map`** to get fresh `ref` IDs (`w:NN`) after navigation or dynamic changes
2. If `browser_click` by `ref` fails because the element is occluded or unstable, fall back to `browser_click` with raw `x/y` coordinates
3. If an element is hidden inside a shadow DOM, pass `ax_tree: true` to `browser_map` to bypass the standard DOM walker and read the raw accessibility tree
4. If typing fails, try `paste: true` mode or use `browser_eval` to set the value directly
5. If navigation hangs, try `force: true` or check for blocking dialogs with `browser_dialog`

---

## Getting Help

If you continue to experience issues:

1. **Check the logs** — Review `~/.Weavetab/logs/` for detailed error information
2. **Search GitHub Issues** — Check if your issue has already been reported
3. **Create a minimal reproduction** — Provide steps to reproduce the issue
4. **Include environment details** — OS, Node version, Chrome version, Weavetab version
5. **Report via GitHub** — Open an issue with all relevant information

**For security issues**, please follow the reporting process in [SECURITY.md](SECURITY.md).

---

## Additional Resources

- [Architecture Documentation](ARCHITECTURE.md)
- [Tool Reference](docs/tools/tools.md)
- [Security Policy](SECURITY.md)
- [Contributing Guidelines](CONTRIBUTING.md)
