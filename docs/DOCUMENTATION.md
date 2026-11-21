# Weavetab MCP Documentation

> **Package:** `@weavetab/mcp` | **Version:** 2.6.4 | **License:** AGPLv3 | **Author:** Weavetab (owned by fy2ne)

---

## Overview

Weavetab is an in-process MCP (Model Context Protocol) server providing AI agents with direct control across Chromium browsers and Electron desktop applications. It communicates directly over the Chrome DevTools Protocol (CDP) WebSocket — no WebDriver process, no browser binary download, no cloud middleware.

### Core Capabilities

- **40 Built-in MCP Tools** across functional categories (Vision, Navigation, Input, Tabs, Mission Execution, Dialog, Wait, Storage, Device, Network, Canvas, Output, Evaluation, Office Documents)
- **Direct CDP WebSocket** — Local in-process transport, zero external driver overhead
- **Semantic Delta Engine** — Per-tab snapshot diffing returning only added, modified, or removed elements
- **Ghost Cursor** — Bézier curve click engine with human acceleration and jitter
- **Human Typing Engine** — burst-pattern profiling, per-character jitter, natural pauses
- **Blind Injection** — host-isolated credential injection via `secrets.json` with domain scoping, Shadow DOM isolation, and JS property hardening
- **Self-Learning** — per-domain session memory, knowledge hints, automatic framework detection
- **Security Stack** — domain blacklist, RBAC (5 roles), rate limiter, loop detection, input filter, root guard
- **Burst Mode** — chain N actions in 1 MCP call via `browser_burst`
- **Plugin System** — Extensible plugin ecosystem supporting tool additions, `/` commands (MCP prompts), `@` mentions (MCP resources & URI templates), overrides (with originalHandler wrapping), and tool removals across 3 trust tiers (Official, Verified, Unverified)
- **Built-in `/` Commands & `@` Mentions** — `/page_context`, `/agent`, and `@active-tab` (`weavetab://active-tab`) for zero-tool-call context injection
- **GitHub Automation (Plugin)** — Repo analysis, file reading, issues, and PRs are provided by the official `@weavetab/plugin-github` plugin, not built in

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

## Tool Reference (40 Tools)

All tools share: Zod schema validation, `withSecurity()` pipeline (rate limiting + specificity-ordered domain policy + fail-closed RBAC + per-tool timeout budgets), and structured audit logging.

### Vision & Reading (7 tools)

| Tool | Description |
|------|-------------|
| `browser_map` | DOM enumeration with volatile `w:NN` ref IDs, cached map reuse, `depth: 0` DOM init, Set-of-Marks visual grounding (`visual: true` / `"auto"`), container binding, modal hoisting, nav cluster collapsing, delta diffing, and scope filtering. |
| `browser_find` | Native CDP text search with single and multi-match (`all: true`, `limit: N`), null-body safety, and secret redaction on matched labels without a full DOM walk |
| `browser_scrape` | CSS/XPath structured data extraction in 1 CDP call with unified retry preserving `multiple: false`, live `.value`, and secret redaction |
| `browser_inspect` | Parallel CDP inspection returning computed styles, inline styles, box model, and event listener types with Shadow DOM fallback |
| `browser_snapshot` | MHTML capture/restore of DOM state + resources with non-destructive CSS capture masking, MHTML secret redaction, verified restore paths, and `pathToFileURL()` |
| `browser_screenshot` | PNG/JPEG capture via CDP with non-destructive CSS secret masking and accurate scaled dimensions on >1280px viewports (base64 data URL, zero disk I/O) |
| `browser_console` | Read/clear buffered console logs and exceptions (`0`/`false` preserved, noise filtered across all paths, secrets redacted, 1,000-char entry cap) |

### Navigation (1 tool)

| Tool | Description |
|------|-------------|
| `browser_navigate` | Direct CDP navigation with domain blocklist enforcement, Electron-safe defaults (skips web cookie auto-click), guaranteed non-empty title fallback, and `weavetab://` protocol |

### Input (9 tools)

| Tool | Description |
|------|-------------|
| `browser_click` | Ghost Cursor (Bézier) click with visual mark targeting (`mark: N`), intent memory, opt-in `include_map`, Electron URL safety, and stuck-loop detection |
| `browser_type` | Human keystroke engine with zero-target `document.activeElement` typing, exact ref/selector targeting, anti-unfocus guard, jitter, and burst patterns |
| `browser_type_secret` | Blind Injection from `secrets.json` — strict domain check blocking empty-hostname URLs (`file://`, `about:blank`), exact ref matching, `target: "focused"`, and DOM property hardening |
| `browser_key` | Native keyboard dispatch with combo hotkeys (`"Ctrl+A"`, `"Cmd+K"`), printable text payloads, and Electron-safe `Enter` handling |
| `browser_pointer` | Hover, double-click, drag-and-drop (`buttons: 1`, `end_ref` coordinate verification), and multi-level flyout menu traversal via `hover_chain` |
| `browser_select` | Native `<select>` and custom ARIA/Radix/Shadcn dropdown selection (single `value` or multi-select `values`) plus text range highlighting (`mode: "text"`, `start`/`end`) |
| `browser_fill` | Smart multi-field form batch completion with input discovery scanner (`scan: true`), flexible field selectors, and Google Sheets `grid_data` (`AA`+ columns) |
| `browser_upload` | Bypass file dialogs via CDP `DOM.setFileInputFiles` with cached ActionMap reuse |
| `browser_scroll` | Fast non-blocking directional + element-relative scroll (auto-scrolls off-screen targets into view) |

### Tabs & Windows (2 tools)

| Tool | Description |
|------|-------------|
| `browser_tabs` | Open/switch/close/list/consolidate (Tab Armor-aware dedup with URL normalization)/heal (recover crash). Also list/focus windows |
| `browser_detect` | Detect installed browsers + configured desktop apps (case-insensitive `app` match) and CDP feature coverage per engine |

### Mission Execution (2 tools)

| Tool | Description |
|------|-------------|
| `browser_burst` | Chain N actions in 1 MCP call. Supports 5 macro steps: `type_and_send`, `navigate_and_read`, `click_and_wait`, `scroll_and_read`, `fill_form` |
| `browser_automation` | Inject persistent self-running scripts with clean new-document teardown on `stop`, 100-entry mailbox cap, and recursive redaction on `poll` |

### Dialog & User Interaction (3 tools)

| Tool | Description |
|------|-------------|
| `browser_dialog` | Accept/dismiss JavaScript alert/confirm/prompt dialogs with safe toast escaping and deduplicated listeners |
| `browser_thoughts` | Agent-to-user HUD cards: feedback (one-way) or question with input (sentence/paragraph, 120s default timeout, bridge cleanup on cancel/timeout) |
| `browser_clipboard` | System clipboard R/W (text, images, or both in one write), native OS write priority, macOS `Cmd+V` paste, and secret redaction on read |

### Wait & Timing (2 tools)

| Tool | Description |
|------|-------------|
| `browser_wait` | Wait for element/text/URL/stable/network/auto — accurate timeout status (`success: false` on network timeout) and optional loop counter reset |
| `browser_captcha` | Autonomous zero-API detection and solving for Cloudflare Turnstile, reCAPTCHA v2/v3, GeeTest, and hCaptcha via CDP mouse physics |

### Storage & Cookies (2 tools)

| Tool | Description |
|------|-------------|
| `browser_storage` | Validated `localStorage` & `sessionStorage` get/set/remove/list/clear with secret redaction and 2,000-char value cap on `list` |
| `browser_cookies` | Cookies get/list/set/delete with secret redaction on read and real CDP delete error reporting |

### Device & Environment (2 tools)

| Tool | Description |
|------|-------------|
| `browser_viewport` | Viewport, device emulation, real CDP touch emulation, geolocation, timezone, color scheme (`no-preference` clear), and Electron-safe reset |
| `browser_emulate` | Validated network throttling presets (3G/4G/offline), CPU slowdown (`>= 1`), geolocation, timezone, color scheme, and User-Agent override |

### Network (1 tool)

| Tool | Description |
|------|-------------|
| `browser_network_intercept` | Escaped glob API mocking, tracking blocks, Response-stage passthrough, clean listener teardown, and raw protocol telemetry (TLS/SSL, timing, OS failures) |

### Canvas & Visual (2 tools)

| Tool | Description |
|------|-------------|
| `browser_canvas` | Get image data (base64 PNG) or draw coordinate drag paths (`buttons: 1`) on canvas |
| `browser_highlight` | Visual CDP overlay highlight with `textContent` XSS safety and color allowlisting — zero token cost |

### Output (2 tools)

| Tool | Description |
|------|-------------|
| `browser_pdf` | Print page to PDF — landscape, scale, page ranges, basename traversal guard, auto `.pdf` suffix, and secret masking |
| `browser_recording` | Compile browser screencast frames into video (`.webp`, `.gif`, `.mp4`, `.webm`) with `sessionId` traversal validation |

### Evaluation (1 tool)

| Tool | Description |
|------|-------------|
| `browser_eval` | Run JS via CDP `Runtime.evaluate`, auto-invoke bare zero-arg functions (`() => ...`), and recursively redact secrets across objects/arrays. On `weavetab://` pages, supports `wt-dashboard-command` events |

### Performance (1 tool)

| Tool | Description |
|------|-------------|
| `browser_performance` | CDP metrics (`Performance.enable()`), parallel Core Web Vitals (FCP/LCP/CLS) with observer teardown, and single-eval memory/navigation/resource timings |

### GitHub Automation (Plugin)

GitHub support is no longer a built-in tool. It is provided by the official `@weavetab/plugin-github` plugin, which registers a single `github` tool (actions: `analyze`, `read`, `issues`, `pr`). Install it with `weavetab plugin add @weavetab/plugin-github`.

### Utility (3 tools)

| Tool | Description |
|------|-------------|
| `browser_checkpoint` | Snapshot and restore browser state (cookies, storage, scroll/URL) into `mode: 0o600` checkpoints with bounded restore load wait |
| `browser_pattern_learn` | Read, register, and update named workflow patterns and site quirks per origin |
| `browser_office` | Parse Word (`.docx`), Excel (`.xlsx`), PDF, and CSV files (25MB cap, native `FileReader`, ZIP `word/`/`xl/` sniffing, secret redaction) |

---

## Secrets Management

Secrets are encrypted at rest with fail-closed AES-256-GCM in structured `secrets.json` files with `0o600` permissions, Windows `icacls` owner-only ACLs, and atomic file writes (temp file + rename).

### Resolution Order

1. `./.weavetab/secrets.json` (project-scoped, loaded only when `WT_PROJECT_SECRETS=1` is set or `cwd === os.homedir()`, initialized via `weavetab secrets init --project`)
2. `~/.weavetab/secrets.json` (global default)

> **Note:** The legacy `.env`-based secret provider has been removed. All secrets must use `secrets.json`.

### CLI Commands

```bash
weavetab secrets set MY_KEY          # Prompts for value securely
weavetab secrets list                # Shows keys + domains only (never values)
weavetab secrets rm MY_KEY           # Remove a secret
weavetab secrets init --project      # Create project-scoped secrets + config
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

The value is permanently masked as `[REDACTED]` across all subsequent DOM reads, delta diffs, session trails, compiled patterns, and audit logs, and sensitive inputs use non-destructive CSS masking (`-webkit-text-security: disc` / `color: transparent`) during visual captures.

---

## Configuration

### Config File Locations

- **Global:** `~/.weavetab/config.json` (the only config file Weavetab reads; secrets additionally support `./.weavetab/secrets.json`)

### Config Structure

```json
{
  "browserType": "chromium",
  "headless": false,
  "devMode": false,
  "maxActionsPerMinute": 60,
  "role": "operator",
  "telemetry": false,
  "attachPort": 0,
  "extension": true,
  "cookies": false,
  "syncDataAcrossBrowsers": false,
  "actionabilityTimeoutMs": 300,
  "refCacheTtlMs": 30000,
  "browserFlags": [],
  "policies": [],
  "electron": {
    "discord": "C:\\Users\\<user>\\AppData\\Local\\Discord\\app-<version>\\Discord.exe",
    "antigravity": "C:\\Users\\<user>\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe",
    "vscode": "C:\\Users\\<user>\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"
  }
}
```

### Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `browserType` | string | "chromium" | Browser to use (chromium, firefox, webkit) |
| `headless` | boolean | false | Run browser and launched Electron apps in headless mode |
| `devMode` | boolean | false | Enable HUD overlay and verbose logging |
| `maxActionsPerMinute` | number | 60 | Rate limit for tool executions |
| `role` | string | "operator" | RBAC role (admin, operator, viewer, automation, system) |
| `telemetry` | boolean | false | Enable anonymous usage telemetry |
| `attachPort` | number | 0 | Chrome DevTools Protocol port |
| `extension` | boolean | true | Enable Weavetab extension integration |
| `cookies` | boolean | false | Persist cookies/storage across sessions. When `false`, `document.cookie`, `localStorage`, and `sessionStorage` are all neutered at the browser level (returns empty/null for everything) + a fresh isolated profile is used each session. When `true`, cookies/storage work normally and persist via the profile directory. |
| `syncDataAcrossBrowsers` | boolean | false | Share the persistent cookie profile directory across Chromium browser binaries (`chromium` / `chrome` / `edge`). |
| `proxy` | string | — | Outbound browser proxy URL (overridable via `WT_PROXY_URL`). |
| `actionabilityTimeoutMs` | number | 300 | Actionability readiness timeout in ms (`50`–`15000`). |
| `refCacheTtlMs` | number | 30000 | Cached `w:NN` ref resolution TTL in ms. |
| `browserFlags` | string[] | `[]` | Extra Chromium command-line flags to append on launch. Dangerous flags (`--user-data-dir`, `--remote-debugging-port`, `--remote-debugging-address`, `--remote-allow-origins`, `--disable-web-security`) and `--enable-sync` are automatically stripped, and mandatory Weavetab flags are placed after user flags. |
| `policies` | PolicyEntry[] | `[]` | Domain-level access control policies (see [Domain Policy](#domain-policy) below). Supersedes the legacy `block`/`allow` lists. |
| `electron` | Record<string, any> | `{}` | Map of registered Electron desktop applications (path string, port number, or `{ path, port, url, profileDir, args }`). Also accepts `"apps"` alias. |

---

## Domain Policy

The `policies` config option provides **fine-grained domain-level access control** that supersedes the legacy `block`/`allow` lists. Policies are evaluated **by specificity** (exact match > longest literal domain suffix > wildcard, with array order breaking ties) before every tool execution. Bare domain patterns (e.g. `paypal.com`) match both the exact domain and subdomains (`*.paypal.com`), and trailing FQDN dots are normalized automatically. If no policy matches, `allow` is checked before `block`, then access is allowed by default.

Configure policies in your `config.json` under the top-level `policies` array:

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
| `read-only` | Only observation tools allowed: `map`, `find`, `scrape`, `console` (`read`), `inspect`, `snapshot` (`capture` confined to `snapshotDir`), `screenshot`, `pdf`, `cookies` (`get`/`list` on same origin), `tabs` (`list`/`list_windows`), `wait`, `pattern_learn` (`get`), and `detect`. Blocks `browser_eval` and all mutation tools. |
| `deny` | Complete block of all interactions on that domain. |
| `audit-only` | All tools allowed, with every action logged for audit trails. |

### Key Differences from `block`/`allow` Lists

| Feature | Legacy `block`/`allow` | `policies` |
|---------|----------------------|------------|
| Modes | Only allow or deny (`allow` checked before `block`) | 4 modes: allow, deny, read-only, audit-only |
| Wildcards & Subdomains | Wildcards (`*`) + bare domains match subdomains | Wildcards (`*`) + bare domains match subdomains + trailing-dot normalization |
| Order | `allow` evaluated before `block` | **Specificity-ordered** (exact > longest literal suffix > wildcard) |
| Granularity | Domain only | Domain + per-tool and per-action read-only enforcement |
| Check timing | Every tool execution | Every tool execution (including `browser_burst` steps and `WeavetabOpen`) |

---

## RBAC Roles

### Role Definitions

| Role | Permissions |
|------|-------------|
| `admin` | Full access to all tools |
| `operator` | Full access to all tools (standard agent role) |
| `viewer` | Read-only observation tools only (`browser_map`, `browser_find`, `browser_scrape`, `browser_console` [read], `browser_inspect`, `browser_snapshot` [capture in `snapshotDir`], `browser_screenshot`, `browser_pdf`, `browser_cookies` [get/list on same origin], `browser_tabs` [list/list_windows], `browser_wait`, `browser_pattern_learn` [get], `browser_detect`). Excludes `browser_eval`. |
| `automation` | Full access except `browser_thoughts` (non-interactive CI/CD mode) |
| `system` | Internal tools only (`browser_thoughts`, `browser_detect`, `browser_performance`, `browser_checkpoint`, `browser_pattern_learn`) |

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

- Use `speed: "fast"` on `browser_scroll` and `profile: "fast"` on `browser_type` for faster execution
- Enable `prune: true` to reduce DOM processing time
- Use cached ref IDs instead of label-based lookups
- Avoid unnecessary DOM walks with `browser_find` for text search

### Memory Optimization

- Clear cache periodically: `weavetab reset`
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
      "name": "my_custom_tool",
      "description": "My custom tool description"
    }
  ]
}
```

```typescript
// my-plugin/index.ts
import { definePlugin, type PluginContext } from "@weavetab/sdk";

export default definePlugin({
  name: "wt-my-tool",

  async onLoad(ctx: PluginContext) {
    ctx.mcp.registerTool({
      name: "my_custom_tool",
      description: "My custom tool description",
      schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      },
      handler: async (args, session) => {
        return { content: [{ type: "text", text: "result" }] };
      }
    });
  }
});
```

### Installing Plugins

```bash
# Official plugins
weavetab plugin add @weavetab/plugin-sample

# Community plugins (any npm name)
weavetab plugin add wt-my-tool
# or via npm
npm install wt-my-tool
```

Installed plugins with a valid `weavetab.json` in `~/.weavetab/plugins/` are automatically discovered on Weavetab startup (with `realpathSync` entry and storage containment and manifest-only permission enforcement; local workspace `./plugins` discovery requires `WT_ALLOW_WORKSPACE_PLUGINS=1`).

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

## Electron & Desktop Application Automation

Weavetab natively supports **generic automation of any Electron or Chromium-based desktop application** (e.g. Discord, Slack, VS Code, Antigravity IDE, Figma, Obsidian, Postman, or local developer applications running from source).

### How It Works Under the Hood
Electron desktop applications run a bundled Chromium/Blink engine under the hood. When started with Chrome DevTools Protocol debugging enabled (either automatically via Weavetab with isolated `XDG_CONFIG_HOME`/`XDG_DATA_HOME` and filtered flags or via `--remote-debugging-port`), Weavetab connects directly to the desktop app's internal WebSockets and exposes all 40 built-in MCP tools without requiring external drivers or wrappers.

### Registering Applications
In `~/.weavetab/config.json` (under `"electron"` or its `"apps"` alias):

```json
{
  "electron": {
    "discord": "C:\\Users\\<user>\\AppData\\Local\\Discord\\app-<version>\\Discord.exe",
    "antigravity": "C:\\Users\\<user>\\AppData\\Local\\Programs\\antigravity\\Antigravity.exe",
    "vscode": "C:\\Users\\<user>\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    "figma": "C:\\Users\\<user>\\AppData\\Local\\Figma\\Figma.exe",
    "obsidian": "C:\\Users\\<user>\\AppData\\Local\\Obsidian\\Obsidian.exe",
    "my-app": "C:\\path\\to\\my-project\\node_modules\\electron\\dist\\electron.exe"
  }
}
```

### Automating Local / Source-Hosted Projects
When developing an Electron app locally (e.g. `localhost:3000` or running via Vite/Webpack/Electron forge):

1. **Launch with remote debugging enabled:**
   ```bash
   npx electron . --remote-debugging-port=9222
   # or with npm scripts:
   npm run dev -- --remote-debugging-port=9222
   ```

2. **Automate via MCP tools:**
   Set `"attachPort": 9222` or register the dev script in `"electron"` config.

### Tool Execution Flow with Desktop Apps
Every Weavetab tool supports the optional `app` parameter:

| Tool Call | Desktop Behavior |
| :--- | :--- |
| `browser_navigate({ app: "antigravity" })` | Launches or connects to Antigravity's CDP session |
| `browser_tabs({ action: "list", app: "antigravity" })` | Lists all windows, webviews, and workbench tabs in the app |
| `browser_tabs({ action: "switch", tabId: "<id>", app: "antigravity" })` | Switches active focus to the specified workbench or window |
| `browser_map({ app: "antigravity" })` | Generates semantic Ref IDs (`w:NN`) for the desktop app's active window |
| `browser_click({ ref: "w:12", app: "antigravity" })` | Sends Ghost Cursor click to the desktop app element |
| `browser_type({ ref: "w:15", text: "...", app: "discord" })` | Types text directly into the desktop app input field |
| `browser_eval({ expression: "...", app: "vscode" })` | Evaluates JavaScript inside the desktop app frame context |

---

## Troubleshooting

### Common Issues

1. **CDP connection failed** — Ensure Chrome is running with `--remote-debugging-port=9222`
2. **Extension not loading** — Use headed mode or `--headless=new` Chrome flag
3. **High memory usage** — Clear cache with `weavetab reset` or enable pruning
4. **Token usage high** — Use `delta: true` and `prune: true` in `browser_map`
5. **Clicks failing** — Use ref IDs from `browser_map` instead of labels

### Debug Mode

Enable `devMode: true` in config for:

- Real-time tool execution timing
- Token usage estimates
- Detailed error messages
- HUD overlay in browser

### Audit Logs

Review the latest `~/.weavetab-system/logs/mission_<timestamp>.log` (automatically pruned to retain the latest 30 `mission_*` files) for:

- Tool invocation history
- Error messages and stack traces
- Domain policy violations
- Security events

For detailed troubleshooting, see [TROUBLESHOOTING.md](../TROUBLESHOOTING.md).

---

## Additional Resources

- [Tool Reference](tools/tools.md)
- [Plugin System Guide](PLUGINS.md)
- [Architecture Documentation](../ARCHITECTURE.md)
- [Support & Community](../SUPPORT.md)
- [Security Policy](../SECURITY.md)
- [Contributing Guidelines](../CONTRIBUTING.md)
- [Troubleshooting Guide](../TROUBLESHOOTING.md)
