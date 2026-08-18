# Weavetab MCP Documentation

> **Package:** `@weavetab/mcp` | **Version:** 2.5.0 | **License:** AGPLv3 | **Author:** fy2ne

---

## Overview

Weavetab is a production-grade, in-process MCP (Model Context Protocol) server that grants AI agents human-like control over Chromium browsers. It communicates directly over the Chrome DevTools Protocol (CDP) at Layer 0 — no WebDriver process, no browser binary download, no Playwright/Puppeteer abstraction layer.

### Core Capabilities

- **45 Built-in MCP Tools** across 15 functional categories (Vision, Navigation, Input, Tabs, Mission Execution, Dialog, Wait, Storage, Device, Network, Canvas, Output, Evaluation, GitHub, Office Documents)
- **Direct CDP WebSocket** — 3-8ms mean latency, zero process overhead
- **Semantic Delta Engine** — 5-10x token reduction via per-tab snapshot diffing
- **Ghost Cursor** — Bézier curve click engine with human acceleration and jitter
- **Human Typing Engine** — burst-pattern profiling, per-character jitter, natural pauses
- **Blind Injection** — enterprise-grade credential injection via `secrets.json` with domain scoping, Shadow DOM isolation, and JS property hardening
- **Self-Learning** — per-domain session memory, knowledge hints, automatic framework detection
- **Security Stack** — domain blacklist, RBAC (4 roles), rate limiter, loop detection, input filter, root guard
- **Burst Mode** — chain N actions in 1 MCP call via `browser_burst`
- **Plugin System** — Extensible plugin ecosystem supporting tool additions, overrides (with originalHandler wrapping), and tool removals across 3 trust tiers (Official, Verified, Unverified)
- **GitHub Integration** — 4 built-in tools for repo analysis, file reading, issues, and PRs

### Weavetab Skills

**Weavetab Skills** is an optional companion package (`@weavetab/skills`) that provides pre-built workflow patterns and mission templates for AI agents. These skills help agents understand complex Weavetab workflows and execute multi-step missions more effectively.

**Installation:**
```bash
npm install -g @weavetab/skills
```

**Available Skills:**
- **Multi-step Form Automation** — Complex form filling with validation handling
- **E-commerce Checkout** — Shopping cart navigation and payment processing
- **Data Extraction Pipelines** — Structured data scraping and export
- **Content Management Systems** — WordPress, Drupal, and CMS-specific workflows
- **API Testing & Validation** — Endpoint testing and response verification

Skills are automatically discovered by compatible MCP clients and provide context-aware guidance for mission planning.

---

## Architecture

```
MCP Client → stdio/WebSocket → WithSecurity Pipeline → CDP WebSocket → Chromium
                                 (RateLimit → DomainPolicy → RBAC)
```

### Five Architectural Layers

| Layer | Components | Responsibility |
|-------|-----------|----------------|
| **Transport** | stdio (JSON-RPC), WebSocket (port 3000) | MCP client communication |
| **Security & Governance** | Domain blacklist, Rate limiter, RBAC, Root guard, Storage blocker | Pre-flight checks |
| **Intelligence** | Session memory, Delta engine, DOM pruner, Trail/loop detection, Knowledge hints, Vision fallback | Token optimization, self-learning |
| **Sensor Systems** | Network telemetry, DOM mutations, Human pacing, Agent state machine, Thought HUD | Runtime awareness |
| **CDP Bridge** | DOM walker, Ghost cursor, Keystroke engine, Pruner, Shadow DOM injector, Tab manager, Browser launcher | Browser control |

---

## Tool Reference (44+ Tools)

All tools share: Zod schema validation, `withSecurity()` pipeline (rate limiting + domain policy + RBAC), structured audit logging.

### Vision & Reading (7 tools)

| Tool | Description |
|------|-------------|
| `browser_map` | DOM enumeration with stable `w:NN` ref IDs. Supports `delta` (diff mode), `prune` (one-shot compression), `ax_tree` (Shadow DOM fallback), `scope` filtering, `query` filtering |
| `browser_find` | Native CDP text search — ~10x cheaper than map, single CDP call |
| `browser_scrape` | CSS/XPath structured data extraction in 1 CDP call |
| `browser_inspect` | Computed CSS styles + inline styles + event listener types |
| `browser_snapshot` | MHTML capture/restore of DOM state + resources |
| `browser_screenshot` | PNG/JPEG capture via CDP, full-page + clip region, returns base64 data URL (no file pollution) |
| `browser_console` | Read/clear buffered console logs and exceptions |

### Navigation (1 tool)

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to URL with domain blocklist enforcement. Supports `Weavetab://` protocol for persistent local playgrounds |

### Input (9 tools)

| Tool | Description |
|------|-------------|
| `browser_click` | Ghost Cursor (Bézier) click with intent memory, occlusion detection, stuck-loop detection |
| `browser_type` | Human keystroke engine with jitter, burst patterns, paste mode, stuck detection |
| `browser_type_secret` | Blind Injection from `secrets.json` — domain check before value load, Shadow DOM isolation, JS property hardening |
| `browser_key` | Native keyboard dispatch with modifier keys (Ctrl, Shift, Alt, Meta) |
| `browser_pointer` | Hover, double-click, drag-and-drop via native mouse events |
| `browser_select` | Native `<select>` dropdown selection — React/Vue safe (prototype setter + events) |
| `browser_fill` | Smart multi-field form fill — auto-detects text, select, checkbox, radio, contenteditable |
| `browser_upload` | Bypass file dialogs via CDP `DOM.setFileInputFiles` |
| `browser_scroll` | Directional + element-relative scroll via native wheel events |

### Tabs & Windows (2 tools)

| Tool | Description |
|------|-------------|
| `browser_tabs` | Open/switch/close/list/consolidate (dedup)/heal (recover crash). Also list/focus windows |
| `browser_detect` | Detect installed browsers + CDP feature coverage per engine (Chromium, Firefox, WebKit) |

### Mission Execution (3 tools)

| Tool | Description |
|------|-------------|
| `browser_burst` | Chain N actions in 1 MCP call. Supports 4 macro steps: `type_and_send`, `navigate_and_read`, `click_and_wait`, `scroll_and_read` |
| `browser_plan` | Live task dashboard in browser Shadow DOM overlay. User sees progress, can comment |
| `browser_automation` | Inject persistent self-running scripts — monitoring, polling, background extraction |

### Dialog & User Interaction (3 tools)

| Tool | Description |
|------|-------------|
| `browser_dialog` | Accept/dismiss JavaScript alert/confirm/prompt dialogs |
| `browser_thought` | Green thought bubbles: feedback (one-way) or question with input (sentence/paragraph modes) |
| `browser_clipboard` | System clipboard R/W (text + images) |

### Wait & Timing (2 tools)

| Tool | Description |
|------|-------------|
| `browser_wait` | Wait for element/text/URL/stable/network/auto — timeout configurable |
| `browser_reset_loop_counter` | Manual loop detection override |

### Storage & Cookies (2 tools)

| Tool | Description |
|------|-------------|
| `browser_storage` | localStorage & sessionStorage get/set/clear |
| `browser_cookies` | Cookies get/set/delete |

### Device & Environment (1 tool)

| Tool | Description |
|------|-------------|
| `browser_viewport` | Viewport, device emulation, geolocation, timezone override |

### Network (1 tool)

| Tool | Description |
|------|-------------|
| `browser_network_intercept` | Mock API responses, block tracking, and retrieve raw protocol network telemetry (TLS/SSL certificate metadata, microsecond timing breakdown, OS-level failure reasons) |

### Canvas & Visual (2 tools)

| Tool | Description |
|------|-------------|
| `browser_canvas` | Get image data (base64 PNG) or draw points on canvas |
| `browser_highlight` | Visual CDP overlay highlight — zero token cost |

### Output (2 tools)

| Tool | Description |
|------|-------------|
| `browser_pdf` | Print page to PDF — landscape, scale, page ranges |
| `browser_recording` | Compile browser screencast frames into video (.webp, .gif, .mp4, .webm) |

### Evaluation (1 tool)

| Tool | Description |
|------|-------------|
| `browser_eval` | Run arbitrary JS via CDP Runtime.evaluate. On `Weavetab://` pages, supports building UIs via `wt-dashboard-command` events |

### Performance (1 tool)

| Tool | Description |
|------|-------------|
| `browser_performance` | FCP, LCP, TTI metrics, resource timings |

### Macro (1 tool)

| Tool | Description |
|------|-------------|
| `browser_macro_compile` | Compile successful trails into burst macros |

### GitHub (4 tools)

| Tool | Description |
|------|-------------|
| `github_analyze` | Repo metadata, file tree, README snippet |
| `github_read` | Read file contents via raw.githubusercontent.com (no API limit cost) |
| `github_issues` | List/search/fetch issues with comments |
| `github_get_pr` | PR details + changed files + comments |

### Utility (2 tools)

| Tool | Description |
|------|-------------|
| `browser_thoughts` | Ask user a question or show a green sticky feedback |
| Plugins | Dynamic loading from any npm package with `weavetab.json` (or `@weavetab/plugin-*`) |

---

## Secrets Management

Secrets are stored in structured `secrets.json` files with `chmod 600` enforcement and atomic file writes (temp file + rename).

### Resolution Order

1. `./.Weavetab/secrets.json` (project-scoped, opt-in via `Weavetab secrets init --project`)
2. `~/.Weavetab/secrets.json` (global default)

> **Note:** The legacy `.env`-based `EnvSecretProvider` is **deprecated and no longer supported**. All secrets must use `secrets.json`.

### CLI Commands

```bash
Weavetab secrets set MY_KEY          # Prompts for value securely
Weavetab secrets list                # Shows keys + domains only (never values)
Weavetab secrets rm MY_KEY           # Remove a secret
Weavetab secrets init --project      # Create project-scoped secrets + config
```

### Secrets File Format

```json
{
  "API_KEY": {
    "value": "sk-...",
    "domains": ["api.example.com"],
    "description": "Production API key"
  }
}
```

### Blind Injection

Use `browser_type_secret` to inject credentials without exposing them to the LLM:

```typescript
browser_type_secret({ 
  id: "w:1", 
  envKey: "API_KEY" 
})
```

The value is permanently masked as `[REDACTED]` in all subsequent DOM reads and audit logs.

---

## Configuration

### Config File Locations

- **Global:** `~/.Weavetab/config.json`
- **Project:** `./.Weavetab/config.json` (if exists, takes precedence)

### Config Structure

```json
{
  "browserType": "chromium",
  "headless": false,
  "devMode": true,
  "maxActionsPerMinute": 60,
  "role": "admin",
  "telemetry": false,
  "attachPort": 0,
  "disableExtensions": false,
  "cookies": false,
  "browserFlags": [],
  "policies": []
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `browserType` | string | "chromium" | Browser to use (chromium, firefox, webkit) |
| `headless` | boolean | false | Run browser in headless mode |
| `devMode` | boolean | true | Enable HUD overlay and verbose logging |
| `maxActionsPerMinute` | number | 60 | Rate limit for tool executions |
| `role` | string | "admin" | RBAC role (admin, system, viewer, automation) |
| `telemetry` | boolean | false | Enable anonymous usage telemetry |
| `attachPort` | number | 0 | Chrome DevTools Protocol port |
| `disableExtensions` | boolean | false | Disable Weavetab extension for HUD features |
| `cookies` | boolean | false | Persist cookies/storage across sessions. When `false`, `document.cookie`, `localStorage`, and `sessionStorage` are all neutered at the browser level (returns empty/null for everything) + a fresh isolated profile is used each session. When `true`, cookies/storage work normally and persist via the profile directory. |
| `browserFlags` | string[] | `[]` | Extra Chromium command-line flags to append on launch (e.g., `["--disable-web-security"]`). The `--disable-sync` flag is mandatory and cannot be overridden — any conflicting flag is automatically dropped. |
| `policies` | PolicyEntry[] | `[]` | Domain-level access control policies (see [Domain Policy](#domain-policy) below). Supersedes the legacy `block`/`allow` lists. |

---

## Domain Policy

The `policies` config option provides **fine-grained domain-level access control** that supersedes the legacy `block`/`allow` lists. Policies are checked **in array order** before every tool execution — the first matching pattern wins. If no policy matches, the legacy `block`/`allow` lists are checked as fallback, then access is allowed by default.

Configure policies directly in your config file (or via `~/.Weavetab/policy.json`):

```json
{
  "policies": [
    {
      "pattern": "*.banking.com",
      "mode": "deny"
    },
    {
      "pattern": "banking.com",
      "mode": "allow"
    },
    {
      "pattern": "*.internal.com",
      "mode": "read-only"
    },
    {
      "pattern": "*.trusted.com",
      "mode": "allow"
    },
    {
      "pattern": "*.audit-logs.com",
      "mode": "audit-only"
    }
  ]
}
```

### Policy Modes

| Mode | Description |
|------|-------------|
| `allow` | Full access to all tools. Explicitly whitelists a domain. |
| `read-only` | Only observation tools allowed: map, find, scrape, console, eval, inspect, snapshot, pdf, cookies. Blocks write tools (click, type, navigate, etc.). |
| `deny` | Complete block of all interactions on that domain. |
| `audit-only` | All tools allowed, but every action is logged for audit trails. |

### Key Differences from `block`/`allow` Lists

| Feature | Legacy `block`/`allow` | `policies` |
|---------|----------------------|------------|
| Modes | Only allow or deny | 4 modes: allow, deny, read-only, audit-only |
| Wildcards | Supported | Supported (`*` wildcard) |
| Order | No ordering | **First match wins** — order matters |
| Granularity | Domain only | Domain + per-tool enforcement (read-only blocks writes) |
| Check timing | At navigation | Every tool execution |

---

## RBAC Roles

### Role Definitions

| Role | Permissions |
|------|-------------|
| `admin` | Full access to all tools and system operations |
| `operator` | Full tool access except system operations (logs, detect, performance) |
| `viewer` | Read-only access to observation tools only |
| `automation` | Restricted to burst/plan/wait/map for automated workflows |

### Setting Role

```json
{
  "role": "viewer"
}
```

---

## Performance Optimization

### Token Efficiency

Use `browser_map` with delta and pruning for maximum efficiency:

```typescript
// First call: full map
browser_map({ prune: true })

// Subsequent calls: only changes
browser_map({ delta: true, prune: true })
```

### Latency Optimization

- Use `fast: true` in click operations for faster execution
- Enable `prune: true` to reduce DOM processing time
- Use cached ref IDs instead of label-based lookups
- Avoid unnecessary DOM walks with `browser_find` for text search

### Memory Optimization

- Clear cache periodically: `Weavetab reset`
- Use `limit` parameter in `browser_map` to reduce cache size
- Enable `prune: true` to reduce memory footprint
- Restart Weavetab for long-running sessions

---

## Plugin System

### Creating a Plugin

Create any npm package with a `weavetab.json` manifest at its root:

```json
// my-plugin/package.json
{
  "name": "wt-my-tool",
  "version": "1.0.0",
  "main": "index.js",
  "type": "module"
}
```

```json
// my-plugin/weavetab.json
{
  "name": "My Custom Tool",
  "version": "1.0.0",
  "description": "Custom MCP tool for Weavetab",
  "tools": [
    {
      "name": "browser_my_custom_tool",
      "description": "My custom tool description"
    }
  ]
}
```

```typescript
// my-plugin/index.ts
import type { WeavetabPlugin } from "@weavetab/mcp";

const plugin: WeavetabPlugin = {
  name: "wt-my-tool",
  version: "1.0.0",
  tools: [
    {
      name: "browser_my_custom_tool",
      description: "My custom tool description",
      handler: async (args, session, config) => {
        // Your tool implementation
        return { success: true, data: "result" };
      }
    }
  ]
};

export default plugin;
```

### Installing Plugins

```bash
# Official plugins
wt plugin add @weavetab/plugin-sample

# Community plugins (any npm name)
wt plugin add wt-my-tool
# or via npm
npm install wt-my-tool
```

Plugins with a valid `weavetab.json` are automatically discovered on Weavetab startup.

---

## Weavetab Skills

### Using Skills

Skills provide pre-built workflow patterns that help agents understand complex multi-step operations:

```bash
npm install -g @weavetab/skills
```

### Available Skills

- **Form Automation** — Handles complex forms with validation, multi-page flows, and error recovery
- **E-commerce** — Shopping cart navigation, product selection, checkout processes
- **Data Extraction** — Structured scraping, pagination handling, data export
- **CMS Workflows** — WordPress, Drupal, and other CMS-specific operations
- **API Testing** — Endpoint discovery, request/response validation, test automation

### Skill Integration

Skills are automatically discovered by MCP clients and provide:

- Context-aware workflow guidance
- Step-by-step mission templates
- Error handling patterns
- Best practice recommendations

---

## Troubleshooting

### Common Issues

1. **CDP connection failed** — Ensure Chrome is running with `--remote-debugging-port=9222`
2. **Extension not loading** — Use headed mode or `--headless=new` Chrome flag
3. **High memory usage** — Clear cache with `Weavetab reset` or enable pruning
4. **Token usage high** — Use `delta: true` and `prune: true` in `browser_map`
5. **Clicks failing** — Use ref IDs from `browser_map` instead of labels

### Debug Mode

Enable `devMode: true` in config for:

- Real-time tool execution timing
- Token usage estimates
- Detailed error messages
- HUD overlay in browser

### Audit Logs

Review `~/.Weavetab/logs/audit.log` for:

- Tool invocation history
- Error messages and stack traces
- Domain policy violations
- Security events

For detailed troubleshooting, see [TROUBLESHOOTING.md](../TROUBLESHOOTING.md).

---

## Additional Resources

- [Plugin System Guide](PLUGINS.md)
- [Architecture Documentation](../ARCHITECTURE.md)
- [Tool Reference](TOOLS.md)
- [Security Policy](../SECURITY.md)
- [Contributing Guidelines](../CONTRIBUTING.md)
- [Troubleshooting Guide](../TROUBLESHOOTING.md)
- [Comparison with Other Tools](../.upgrade/compare.md)
