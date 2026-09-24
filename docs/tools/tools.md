---
title: "MCP Tools (44 Tools)"
description: "Complete reference of all 44 production-grade Weavetab automation tools."
product: mcp
section: tools
icon: Wrench
slug: tools
---

# MCP Tools Master Reference

Weavetab exposes **49 production-grade MCP tools** engineered for sub-10ms browser automation, visual inspection, desktop app orchestration, zero-API CAPTCHA solving, and human-like interaction.

Every tool adheres to a strict contract:
- **Zod schema validation** for all runtime arguments
- **`withSecurity()` pipeline** enforcing rate limits, domain policies, and RBAC roles
- **Structured audit logging** via `logAction()`
- **Zero-waste token models** using volatile `w:NN` ref IDs, semantic deltas, and DOM pruning

---

## Tool Directory

| # | Tool Name | Category | Description |
| :--- | :--- | :--- | :--- |
| 1 | `browser_map` | Vision & Reading | DOM snapshotter with volatile `w:NN` ref IDs, delta diffing, pruning, and AX tree fallback. Supports `app`. |
| 2 | `browser_navigate` | Navigation & Environment | Navigates to a URL with blocklist checks, network idle wait, and desktop app connections. Supports `app`. |
| 3 | `browser_click` | Input & Interaction | Physical click engine using Bézier Ghost Cursor kinematics with 5-layer targeting fallback. Supports `app`. |
| 4 | `browser_type` | Input & Interaction | Keystroke dispatch with humanized temporal jitter, stuck-input breaking, and clearFirst. Supports `app`. |
| 5 | `browser_type_secret` | Input & Interaction | Blind credential injection from `secrets.json` without exposing values to LLM context. Supports `app`. |
| 6 | `browser_key` | Input & Interaction | Presses native key combinations (Enter, Tab, Escape, Ctrl+C, Alt+F4, etc.). Supports `app`. |
| 7 | `browser_scroll` | Input & Interaction | Directional and element-relative smooth scrolling via CDP wheel events. Supports `app`. |
| 8 | `browser_dialog` | Dialog & Human Oversight | Accepts, dismisses, or responds to JavaScript `alert`, `confirm`, and `prompt` dialogs. |
| 9 | `browser_burst` | Mission & Automation | Atomic multi-step action pipeline execution in a single JSON-RPC round-trip. Supports `app`. |
| 10 | `browser_tabs` | Tabs & Windows | Full tab & window CRUD lifecycle management (open, switch, close, consolidate, heal). Specify `app` when targeting desktop apps to avoid opening web browser. |
| 11 | `browser_wait` | Wait, Timing & Safety | Blocks execution until DOM element, text, URL pattern, network idle, or stability is met. Supports `app`. |
| 12 | `browser_captcha` | Wait, Timing & Safety | Autonomous zero-API solving of Turnstile, reCAPTCHA, GeeTest, and hCaptcha challenges. |
| 13 | `browser_thoughts` | Dialog & Human Oversight | Visual agent-to-user status HUD overlay (feedback banner or interactive question modal). |
| 14 | `browser_pointer` | Input & Interaction | Precision mouse control for hover flyouts, clicks, double-clicks, and drag-and-drop. Supports `app`. |
| 15 | `browser_select` | Input & Interaction | Selects options in native `<select>` dropdowns with framework-safe synthetic events. Supports `app`. |
| 16 | `browser_fill` | Input & Interaction | Smart multi-field form batch completion across text inputs, radios, checkboxes, and selects. Supports `app`. |
| 17 | `browser_highlight` | Canvas & Visual Overlays | Zero-token visual CDP overlay highlights over target elements without DOM mutations. Supports `app`. |
| 18 | `browser_upload` | Input & Interaction | File input attachment bypassing OS pickers via CDP `DOM.setFileInputFiles`. Supports `app`. |
| 19 | `browser_find` | Vision & Reading | Sub-5ms in-page text search via CDP `Page.searchInPage`. ~10× cheaper than `browser_map`. Supports `app`. |
| 20 | `browser_storage` | Storage & Cookies | Key-value store management for `localStorage` and `sessionStorage`. Supports `app`. |
| 21 | `browser_network_intercept` | Network & Security | Request mocking, URL pattern blocking, and network timing/TLS diagnostic extraction. Supports `app`. |
| 22 | `browser_console` | Vision & Reading | Reads and clears buffered console logs, warnings, exceptions, and network errors. Supports `app`. |
| 23 | `browser_pdf` | Output & Media | Prints the active page to PDF with custom scaling, landscape mode, and page ranges. Supports `app`. |
| 24 | `browser_eval` | Script Evaluation | Evaluates arbitrary JavaScript expressions directly in the main frame JS context. Supports `app`. |
| 25 | `browser_cookies` | Storage & Cookies | Complete cookie CRUD management via CDP Network domain. Supports `app`. |
| 26 | `browser_canvas` | Canvas & Visual Overlays | Export canvas pixels as Base64 PNG or execute vector coordinate drawings. Supports `app`. |
| 27 | `browser_scrape` | Vision & Reading | Structured data extraction via CSS or XPath selectors in a single round-trip. Supports `app`. |
| 28 | `browser_snapshot` | Vision & Reading | Capture or restore complete MHTML DOM snapshots including inline resources. Supports `app`. |
| 29 | `browser_screenshot` | Vision & Reading | Visual viewport or full-page capture in PNG or JPEG with custom clip regions. Supports `app`. |
| 30 | `browser_viewport` | Navigation & Environment | Configures viewport dimensions, device scale factor, mobile mode, and touch emulation. Supports `app`. |
| 31 | `browser_clipboard` | Dialog & Human Oversight | Plaintext and base64 image reading/writing to the system clipboard. Supports `app`. |
| 32 | `browser_inspect` | Vision & Reading | Deep DOM element inspection returning computed CSS styles, box model, and event listeners. Supports `app`. |
| 33 | `browser_extract_design` | Vision & Reading | Extracts design tokens, typography, colors, clean CSS, and Tailwind themes with pixel fidelity. Supports `app`. |
| 34 | `browser_automation` | Mission & Automation | Injects self-running background tracking scripts into the page context for polling/monitoring. Supports `app`. |
| 35 | `browser_recording` | Output & Media | Video screencast recording into `.webp`, `.gif`, `.webm`, or `.mp4` formats. Supports `app`. |
| 36 | `browser_detect` | Tabs & Windows | CRITICAL INITIALIZATION TOOL. Detects local browsers and configured desktop apps (Discord, Slack, etc.) and reports connection status, active tabs, and port. |
| 37 | `browser_performance` | Performance & Vitals | Retrieves Core Web Vitals (FCP, LCP, CLS) and detailed network resource timings. Supports `app`. |
| 38 | `browser_github` | GitHub Intelligence | Analyzes repository structure, reads raw files, searches issues, and inspects PRs. |
| 39 | `browser_office` | Office Documents | Parses Word (`.docx`), Excel (`.xlsx`), PDF, and CSV files into structured data. |
| 40 | `browser_emulate` | Navigation & Environment | Emulates network throttling (3G/4G/Offline), CPU slowdown, geolocation, and custom User-Agent. Supports `app`. |
| 41 | `list_plugins` | Plugins & Extensions | Inspects installed SDK plugins, loaded tool overrides, custom schemas, and capability manifests. |
| 42 | `load_plugin` | Plugins & Extensions | Dynamically loads Weavetab plugins by npm package name with isolated sandboxing. |
| 43 | `browser_checkpoint` | Storage & Safety | Snapshot and restore browser state (cookies, storage, scroll/URL) into named checkpoints for session time-travel and rollback. Supports `app`. |
| 44 | `browser_pattern_learn` | Self-Learning & Heuristics | Read, register, update, and record execution outcomes for named workflow patterns and site quirks per origin. Use `action: "get"` to inspect site profiles. |

---

## 1. Vision & DOM Reading

### `browser_map` (Version 3.0)
High-density DOM tree snapshotter with volatile `w:NN` ref IDs. The foundational tool for reading and understanding page structure with zero prompt waste.

**Core 3.0 Capabilities:**
- **Entity & Container Binding**: Binds action buttons/inputs directly to parent cards, rows, or list items under `┌ [Container Header]` trees.
- **Active Modal & Dialog Hoisting**: Automatically detects and isolates active dialogs/modals at the top of the map under `╔═ ACTIVE DIALOG: "..." ═╗`.
- **Nav & Footer Cluster Collapsing**: Compresses cascades of repetitive navigation/footer links (4+ links) into compact `[w:5…w:24] 20 links: "Home" … "Terms"` summaries.
- **High-Density Unified Grammar**: Single-line format distinguishing `val:"..."`, `ph:"..."`, `FOCUSED`, `checked`, and `disabled` states.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `delta` | `boolean?` | Diff mode: returns only elements added or modified since the previous snapshot (up to 97% token savings). |
| `prune` | `boolean?` | One-shot semantic compression: collapses repetitive elements and strips non-interactable noise. |
| `scope` | `string?` | Restricts extraction to a semantic landmark or selector: `"navigation"`, `"main_content"`, `"sidebar"`, `"form"`, `"modal"`, `"utility"`, or CSS selector. |
| `query` | `string?` | Filters elements by accessible name, ARIA role, or label substring. |
| `visual` | `boolean \| "auto"?` | Set-of-Marks visual grounding. Injects numbered badges `[1]…[N]` and returns an annotated screenshot. Use `"auto"` for canvas/WebGL pages with < 5 DOM elements. |
| `ax_tree` | `boolean?` | Uses Chromium Accessibility Tree directly (essential for closed Shadow DOM and canvas SPAs). |
| `full` | `boolean?` | Return full markdown table format with bounding boxes instead of compact list. |
| `force` | `boolean?` | Force full DOM map rebuild even if loop detection says nothing changed. Bypasses skip guard and resets loop strikes. |
| `tab_id` | `string?` | Read a specific background tab ID. |
| `app` | `string?` | Target desktop Electron app name (e.g. `"discord"`, `"vscode"`, `"figma"`). |

```typescript
// Standard high-density read
browser_map()

// Visual grounding for canvas/WebGL/Figma pages (auto-activates when DOM < 5 elements)
browser_map({ visual: "auto" })

// Scope specifically to open modal or active form
browser_map({ scope: "modal" })
browser_map({ scope: "form" })

// Efficient delta polling for changes
browser_map({ delta: true })
```

---

### `browser_find`
Sub-5ms native CDP in-page text search via `Page.searchInPage`. Approximately 10× cheaper than `browser_map` when only checking for text presence or targeting elements by visible string.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `query` | `string` *(required)* | Text search query string. |
| `all` | `boolean?` | Return all matching elements with bounding rects and selectors instead of just the first match. |
| `limit` | `number?` | Maximum number of matches to return when `all: true` (default `10`). |
| `app` | `string?` | Target Electron desktop application. |

```typescript
// Single match check
browser_find({ query: "Order Confirmed" })

// Discover all occurrences of keyword with coordinates & selectors
browser_find({ query: "Delete", all: true, limit: 5 })
```

---

### `browser_scrape`
Rapid structured data extraction via CSS or XPath selectors. Executes a single CDP `Runtime.evaluate` call and returns clean tabular data.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `query` | `string` *(required)* | CSS selector or XPath query expression. |
| `type` | `"css" | "xpath"?` | Selector query type (default `"css"`). |
| `attributes` | `string[]?` | Element attributes to extract per match (default `["textContent"]`). |
| `multiple` | `boolean?` | Return all matches or just the first element (default `true`). |

```typescript
browser_scrape({
  query: ".pricing-card",
  type: "css",
  attributes: ["data-plan", "textContent", "href"]
})
```

---

### `browser_extract_design`
Extracts design tokens (colors, typography, spacing, shadows, CSS variables), semantic HTML layouts, and scoped CSS into structured files or Tailwind themes with 100% pixel fidelity.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `selector` | `string?` | CSS selector of container element (default `"main"`, fallback `"body"`). |
| `format` | `"tailwind" | "vanilla_css" | "tokens_only"?` | Style export preset (default `"tailwind"`). |
| `outputDir` | `string?` | Custom output directory. If omitted, writes to `~/.weavetab/designs/<domain>-<ts>/`. |
| `name` | `string?` | Custom name for the saved design folder (e.g. `"pricing-hero"`). |

```typescript
browser_extract_design({
  selector: "#hero-section",
  format: "tailwind",
  name: "landing-hero"
})
```

---

## 2. Input & Interaction

### `browser_click`
Physical click engine using Ghost Cursor Bézier curve trajectories. Resolves targets through a multi-layer cascade: `mark` (SoM visual grounding) → `ref` → `selector` → `label` → `intent` → `coords`.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `mark` | `number?` | Numbered badge from `browser_map({ visual: true/\"auto\" })`. Zero DOM walk — instant hardware coordinate click. Ideal for canvas/WebGL/Figma. |
| `id` | `string?` | Volatile `w:NN` ref ID from `browser_map` (preferred for DOM). |
| `selector` | `string?` | CSS selector of target element. |
| `label` | `string?` | Visible text label of the target element. |
| `intent` | `string?` | Semantic intent for AI-assisted Memory Intent Intercept. |
| `app` | `string?` | Target Electron desktop application. |

```typescript
// Click visual mark from browser_map({ visual: "auto" })
browser_click({ mark: 3 })

// Preferred for DOM: stable ref ID
browser_click({ id: "w:14" })

// Target desktop application
browser_click({ id: "w:8", app: "discord" })
```

---

### `browser_type`
Realistic humanized keystroke engine with temporal jitter (35–95ms), typing burst profiling, and stuck-input loop detection.

**Key Upgrades:**
- **Zero-Target ActiveElement Typing**: If no `id`/`selector` is passed, automatically detects and types directly into the currently focused `document.activeElement` without throwing errors or requiring prior clicks.
- **Anti-Click Unfocus Guard**: If the target input is already active, avoids redundant hardware clicks that cause focus blur or close open dropdowns.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `text` | `string` *(required)* | Text string to type. |
| `id` | `string?` | Target `w:NN` ref ID (optional if element already focused). |
| `selector` | `string?` | CSS selector for target input. |
| `label` | `string?` | Accessible label or placeholder text. |
| `clearFirst` | `boolean?` | Clear input field value before typing. |
| `paste` | `boolean?` | Fast paste mode (recommended for tokens/strings > 8 chars). |
| `app` | `string?` | Target Electron desktop application. |

```typescript
// Type directly into active focused element (zero target)
browser_type({ text: "Autonomous Agent Query" })

// Type into specific ref ID with clearFirst
browser_type({ id: "w:15", text: "admin@corp.internal", clearFirst: true })
```

---

### `browser_type_secret`
Enterprise-grade blind credential injection from encrypted local storage (`secrets.json`). Injects sensitive tokens, passwords, and 2FA keys directly into input fields via CDP without exposing plaintext values to the AI context, audit logs, or DOM reads.

**Key Upgrades:**
- **Zero-Exposure In-Process Resolution**: The model passes only the key name (`envKey: "MY_KEY"`). The MCP server resolves the value in-process and enforces domain scoping.
- **Universal Selector Support**: Accepts direct CSS selectors (`#password`, `input[type='password']`, `.pwd-field`), ActionMap ref IDs (`w:5`), or `target: "focused"`.
- **Automatic DOM Hardening**: Injected elements are tagged with `data-wt-secret="true"`, instance `.value` getters are overridden with `[REDACTED]`, and symbol coercion/JSON serialization leaks are sealed.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `envKey` | `string` *(required)* | Key name stored in `secrets.json` (e.g. `"GITHUB_TOKEN"`, `"TEST_KEY"`). |
| `id` | `string?` | Target element `w:NN` ref ID or CSS selector. |
| `target` | `string?` | Target element alias (`"focused"`, selector, or ref ID). |
| `app` | `string?` | Target Electron desktop application. |

```typescript
// Inject credential into password field via CSS selector
browser_type_secret({
  id: "#password",
  envKey: "PROD_DB_PASSWORD"
})

// Inject into focused active element
browser_type_secret({
  target: "focused",
  envKey: "AWS_SESSION_TOKEN"
})
```

---

### `browser_fill`
Smart multi-field form batch completion across text inputs, radios, checkboxes, and selects.

**Key Upgrades:**
- **Input Discovery Scanner (`scan: true`)**: Call with `scan: true` (or empty) to get a lightweight JSON list of all fillable inputs on the page (with ref IDs, types, names, labels, current values, and focus states) in ~30 tokens without dumping the entire DOM.
- **Flexible Field Target Matching**: Supports targeting fields by `ref`, `selector`, `target`, `name`, `placeholder`, or `label`.
- **Google Sheets & Canvas Spreadsheet Grid Fill**: Supports typing directly into spreadsheet cell coordinates via `grid_data: [{ cell: "A1", value: "Revenue" }]`.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `fields` | `array?` | Array of field objects (`{ ref?, selector?, name?, label?, value }`). |
| `scan` | `boolean?` | Return all fillable inputs on the page without mutating DOM. |
| `inputs` | `boolean?` | Alias for `scan`. |
| `blast_mode` | `boolean?` | Fill all fields simultaneously in a single CDP eval round-trip. |
| `submit` | `string?` | Optional ref ID (`w:NN`) of submit button to click after filling. |
| `grid_data` | `array?` | Array of `{ cell: "A1", value: "..." }` pairs for Google Sheets / Canvas grids. |
| `app` | `string?` | Target Electron desktop application. |

```typescript
// 1. Discover all editable inputs on page (~30 tokens)
browser_fill({ scan: true })

// 2. Batch fill form fields by ref, name, or label
browser_fill({
  fields: [
    { ref: "w:12", value: "Anas" },
    { name: "email", value: "anas@example.com" },
    { label: "Country", value: "Morocco" }
  ],
  submit: "w:18"
})
```

---

### `browser_pointer`
Precision mouse control for hover flyouts, clicks, double-clicks, and drag-and-drop.

**Key Upgrades:**
- **Multi-Level `hover_chain`**: Traverse complex multi-level nested menus (e.g. Photoshop/Photopea `"File" → "Export As" → "PNG"`, Figma, or enterprise dashboards) in a single tool call without custom eval scripts.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `action` | `"hover" | "click" | "dblclick" | "drag"` | Mouse action type. |
| `id` | `string?` | Target `w:NN` ref ID. |
| `selector` | `string?` | CSS selector of target element. |
| `hover_chain` | `string[]?` | Array of labels/selectors to hover sequentially (e.g. `["File", "Export As", "PNG"]`). |
| `from` | `object?` | Drag start coordinates `{ x, y }` or target ID. |
| `to` | `object?` | Drag destination coordinates `{ x, y }` or target ID. |
| `app` | `string?` | Target Electron desktop application. |

```typescript
// Glide through multi-level flyout menu
browser_pointer({ hover_chain: ["File", "Export As", "PNG"] })
```

---

### `browser_key`
Native keyboard dispatch with modifier keys and hotkey combos.

**Key Upgrades:**
- **Hotkey Combinations**: Supports standard key combo strings like `"Ctrl+A"`, `"Control+Shift+P"`, `"Cmd+K"`, `"Alt+Tab"`.
- **Zero Lag Execution**: Removed arbitrary post-key wait times (<20ms execution on standard keys).

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `key` | `string` *(required)* | Key name or hotkey combination (`"Enter"`, `"Tab"`, `"Escape"`, `"Ctrl+A"`, `"Cmd+K"`). |
| `app` | `string?` | Target Electron desktop application. |

```typescript
browser_key({ key: "Enter" })
browser_key({ key: "Ctrl+A" })
```

---

### `browser_scroll`
Directional and element-relative smooth scrolling via CDP wheel events.

**Key Upgrades:**
- **Ultra-Fast Non-Blocking Scroll**: Eliminates redundant full DOM action map rebuilds after scrolling, executing in sub-50ms.
- **Direct Target Scrolling**: Supports scrolling specific container elements by `w:NN` ref ID.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `direction` | `"up" | "down" | "left" | "right"` | Scroll direction. |
| `pixels` | `number?` | Scroll distance in pixels (default `400`). |
| `id` | `string?` | Target element `w:NN` ref ID or selector to scroll inside. |
| `app` | `string?` | Target Electron desktop application. |

---

### `browser_emulate`
Emulate environmental conditions over CDP: network throttling (Slow 3G, Fast 3G, 4G, Offline), CPU slowdown multipliers, geolocation overrides, timezone IDs, and custom User-Agent strings.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `network` | `string \| object?` | Throttling profile (`"offline" \| "slow3g" \| "fast3g" \| "4g" \| "online"`) or custom `{ latency, downloadThroughput, uploadThroughput }`. |
| `cpuThrottlingRate` | `number?` | CPU slowdown multiplier (e.g. `2` = 2× slowdown, `4` = 4× slowdown, `1` = normal). |
| `geolocation` | `object?` | Override coordinates `{ latitude: number, longitude: number, accuracy?: number }`. |
| `timezoneId` | `string?` | Override browser timezone (e.g. `'America/New_York'`). |
| `userAgent` | `string?` | Override browser User Agent string. |
| `app` | `string?` | Target Electron desktop application. |

```typescript
browser_emulate({
  network: "slow3g",
  cpuThrottlingRate: 4,
  geolocation: { latitude: 37.7749, longitude: -122.4194 }
})
```

---

## 3. Mission & Automation

### `browser_burst`
High-speed multi-action pipeline. Executes multiple sequential actions in a single MCP round-trip without waiting for LLM turns between steps. PREFER THIS over individual single-action calls to slash latency and token burn. Supports native primitives (`browser_click`, `browser_fill`, `browser_type`, `browser_type_secret`, `browser_navigate`, `browser_key`, `browser_scroll`, `browser_wait`, `browser_map`) plus compound macros (`type_and_send`, `click_and_wait`, `navigate_and_read`, `scroll_and_read`, `fill_form`).

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `steps` | `array?` | Array of step objects (`{ tool, args }` or flat `{ tool, ...args }`). Alias: `actions`. |
| `actions` | `array?` | Alias for `steps`. |
| `compile_from_history` | `boolean?` | Compile recent successful session trail actions into a macro. If `steps` omitted, executes compiled macro directly. |
| `history_limit` | `number?` | Recent trail entries to inspect when compiling (default `20`). |
| `dry_run` | `boolean?` | With `compile_from_history: true`, returns compiled steps without executing. |
| `stop_on_error` | `boolean?` | Halt execution immediately if a step fails to prevent cascade errors (default `true`). |
| `batch` | `boolean?` | Defer action map generation until all steps are complete. |
| `app` | `string?` | Target Electron desktop application context. |

```typescript
// Burst form filling and submission in a single round-trip
browser_burst({
  steps: [
    { tool: "browser_fill", ref: "w:12", value: "admin@corp.internal" },
    { tool: "browser_fill", ref: "w:14", value: "securePassword123" },
    { tool: "click_and_wait", ref: "w:18" }
  ]
})

// Compile and replay recent exploratory actions
browser_burst({ compile_from_history: true })
```

---

## 4. Autonomous CAPTCHA Solving

### `browser_captcha`
Autonomous zero-API challenge detection and solving. Solves Cloudflare Turnstile, Google reCAPTCHA v2/v3, GeeTest sliders, Arkose Labs, and hCaptcha locally using real CDP mouse physics and arithmetic heuristics — requiring **zero external API keys or third-party solver services**.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `action` | `"detect" | "solve" | "wait_for_user" | "status"` *(required)* | CAPTCHA action. |
| `timeout` | `number?` | Max solving timeout in milliseconds (default `120000`). |

```typescript
browser_captcha({ action: "solve", timeout: 45000 })
```

---

## 5. GitHub Intelligence

### `browser_github`
Interact with GitHub repositories without burning browser turns. Analyze repository structure and trees, read raw source files (with optional line ranges), search and inspect issues with comment threads, and examine PR diffs and reviews.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `action` | `"analyze" \| "read" \| "issues" \| "pr"` *(required)* | Operation to perform. |
| `repo` | `string?` | Optional 'owner/repo' slug or GitHub URL. If omitted, uses active tab's repository. |
| `paths` | `string[]?` | For action: 'read'. File paths relative to repository root. |
| `line_range` | `[number, number]?` | For action: 'read'. Optional [start, end] 1-indexed line range. |
| `number` | `number?` | For action: 'issues' or 'pr'. Issue or PR number. |
| `search` | `string?` | For action: 'issues'. Search query to find issues. |
| `labels` | `string[]?` | For action: 'issues'. Filter issues by labels. |
| `state` | `"open" \| "closed" \| "all"?` | For action: 'issues'. Filter issues by state. |
| `limit` | `number?` | For action: 'issues'. Max number of issues to return (default 5). |

```typescript
// Analyze repo metadata, file tree, and README
browser_github({ action: "analyze", repo: "weavetab/mcp" })

// Read file contents without API rate limit consumption
browser_github({ action: "read", repo: "weavetab/mcp", paths: ["src/server.ts"], line_range: [1, 50] })

// Inspect PR details and review comments
browser_github({ action: "pr", repo: "weavetab/mcp", number: 42 })

// Search repository issues
browser_github({ action: "issues", repo: "weavetab/mcp", search: "rate limit", state: "open" })
```

---

## 6. Enterprise Documents & Office

### `browser_office`
Parses and extracts structured tabular content, text paragraphs, and metadata from Word (`.docx`), Excel (`.xlsx`/`.xls`), PDF, and CSV files downloaded during browser sessions or referenced via URL.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `action` | `"read" | "list"` *(required)* | Document parsing operation. |
| `file` | `string?` | Path to local document file. |
| `url` | `string?` | Authenticated browser session URL to document. |
| `max_rows` | `number?` | Maximum spreadsheet/table rows to parse. |

```typescript
browser_office({
  action: "read",
  file: "./.weavetab/downloads/financial_report.xlsx",
  max_rows: 100
})
```

---

## 7. Plugins & Extensions

### `list_plugins`
Inspects all dynamically loaded Weavetab SDK plugins, active tool overrides, registered capability manifests, and isolated plugin storage directories.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `verbose` | `boolean?` | Return complete schema definitions and absolute file storage paths (default `false`). |

```typescript
list_plugins({ verbose: true })
```

---

### `load_plugin`
Dynamically loads any published Weavetab plugin by npm package name into the active runtime with isolated sandboxing and hot tool registration.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `name` | `string` *(required)* | The exact npm package name of the plugin to load (e.g. `'@fy2ne/wt-youtube'`, `'my-plugin'`). |

```typescript
load_plugin({ name: "@fy2ne/wt-youtube" })
```

---

### `browser_checkpoint`
Snapshot and restore browser state (cookies, localStorage, sessionStorage, and scroll/URL) into named checkpoints to time-travel and rollback failed automation branches.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `action` | `'save' \| 'restore' \| 'list' \| 'delete'` *(required)* | Action to perform on the checkpoint store. |
| `name` | `string?` | Unique checkpoint name identifier (required for `save`, `restore`, `delete`). |
| `includeDom` | `boolean?` | Whether to include a lightweight DOM snapshot during `save` (default `false`). |
| `app` | `string?` | Target Electron app name if automating desktop applications. |

```typescript
// Save current session state before a risky form submit
browser_checkpoint({ action: "save", name: "pre-checkout-state" })

// Restore and time-travel back if automation failed or hit a roadblock
browser_checkpoint({ action: "restore", name: "pre-checkout-state" })
```

---

## 8. Tabs, Windows & Desktop Environment

### `browser_detect`
CRITICAL INITIALIZATION TOOL. Detects local browser engines and configured desktop applications (Discord, Slack, VS Code, etc.) and reports connection status, active tabs, and port.

**Parameters:**
None.

```typescript
browser_detect()
```

---

### `browser_tabs`
Full tab and window CRUD lifecycle management (open, switch, close, consolidate, heal). Specify `app` when targeting desktop apps (e.g. `app: "discord"`) to avoid opening the web browser.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `action` | `"list" \| "open" \| "close" \| "switch" \| "list_windows" \| "focus_window" \| "consolidate" \| "heal"` *(required)* | Action to perform. |
| `url` | `string?` | URL to open (required for `open`). |
| `app` | `string?` | Optional Electron app name configured in `config.json` under `electron`. |
| `tabId` | `string?` | Target Tab ID (required for `switch` or `close`). |
| `tabIds` | `string[]?` | Multiple Tab IDs for batch `close`. |
| `force` | `boolean?` | Force close protected (anchor) tabs. |
| `windowId` | `number?` | Window ID to focus (required for `focus_window`). |
| `reuse` | `boolean?` | Default `true`. Reuses existing tab if URL is already open. |

```typescript
// Inspect tabs inside Discord desktop application
browser_tabs({ action: "list", app: "discord" })

// Open a new tab in the web browser
browser_tabs({ action: "open", url: "https://github.com" })
```

## 8. Memory, Learning & Profiles

### `browser_pattern_learn`
Read, register, update, and record execution outcomes for named workflow patterns and site quirks. Use `action: "get"` at session start to inspect a site profile and decide between fast-path replay (reliability ≥ 0.8) or exploratory navigation.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `origin` | `string?` | Full origin (e.g. `'https://github.com'`). Required for write actions. If omitted with `get`, reads the active tab origin. |
| `action` | `"get" \| "learn" \| "record_execution" \| "record_quirk"` | Default `"learn"`. `"get"` returns the full site profile. |
| `pattern` | `string?` | With `get`: returns reliability score for this specific named pattern only. |
| `name` | `string?` | Pattern name in snake_case (required for `learn` and `record_execution`). |
| `steps` | `object[]?` | Workflow steps array containing tool calls and parameters (required for `learn`). |
| `success_indicator` | `string?` | CSS selector or URL confirming workflow success. |
| `entry` | `string?` | URL path or pattern where workflow starts. |
| `success` | `boolean?` | Execution outcome (required for `record_execution`). |
| `duration_ms` | `number?` | Execution duration in milliseconds. |
| `quirk_key` | `string?` | Quirk key: `"cookie_banner"`, `"rate_limit"`, or `"modal_popups"`. |
| `quirk_data` | `object?` | Quirk payload details. |

```typescript
// Inspect site memory profile at session start
browser_pattern_learn({ action: "get" })

// Check reliability for a specific workflow pattern
browser_pattern_learn({ action: "get", origin: "https://github.com", pattern: "create_pull_request" })

// Learn a successful checkout flow
browser_pattern_learn({
  origin: "https://shop.example.com",
  action: "learn",
  name: "cart_checkout",
  entry: "/cart",
  steps: [
    { tool: "browser_click", target: "#checkout-button" },
    { tool: "browser_type", target: "#promo-code", value: "SUMMER" }
  ],
  success_indicator: ".order-confirmation"
})

// Update pattern reliability score following an execution
browser_pattern_learn({
  origin: "https://shop.example.com",
  action: "record_execution",
  name: "cart_checkout",
  success: true,
  duration_ms: 2400
})
```


