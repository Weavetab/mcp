---
title: "MCP Tools (40 Tools)"
description: "Complete reference of all 40 Weavetab automation tools."
product: mcp
section: tools
icon: Wrench
slug: tools
---

# MCP Tools Master Reference

Weavetab exposes **40 built-in MCP tools** for direct in-process CDP browser automation, visual inspection, desktop app orchestration, zero-API CAPTCHA solving, and physical input dispatch.

Every tool adheres to a strict contract:
- **Zod schema validation** for all runtime arguments
- **`withSecurity()` pipeline** enforcing rate limits, domain policies, and RBAC roles
- **Structured audit logging** via `logAction()`
- **Zero-waste token models** using volatile `w:NN` ref IDs, semantic deltas, and DOM pruning

---

## Tool Directory

| # | Tool Name | Category | Description |
| :--- | :--- | :--- | :--- |
| 1 | `browser_map` | Vision & Reading | DOM snapshotter with volatile `w:NN` ref IDs, cached map reuse, `depth: 0` DOM init, delta diffing, pruning, and AX tree fallback. Supports `app`. |
| 2 | `browser_navigate` | Navigation & Environment | Navigates to a URL with blocklist checks, network idle wait, Electron-safe defaults, and non-empty title fallback. Supports `app`. |
| 3 | `browser_click` | Input & Interaction | Physical click engine using Bézier Ghost Cursor kinematics with 5-layer targeting fallback and opt-in `include_map`. Supports `app`. |
| 4 | `browser_type` | Input & Interaction | Keystroke dispatch with humanized temporal jitter, exact ref/selector targeting, stuck-input breaking, and `clearFirst`. Supports `app`. |
| 5 | `browser_type_secret` | Input & Interaction | Blind credential injection from `secrets.json` (blocks empty-hostname URLs like `file://`/`about:blank`) without exposing values to LLM context. Supports `app`. |
| 6 | `browser_key` | Input & Interaction | Presses native key combinations (`Enter`, `Tab`, `Escape`, `Ctrl+C`, `Cmd+K`, etc.) with printable text payloads and Electron-safe Enter handling. Supports `app`. |
| 7 | `browser_scroll` | Input & Interaction | Directional and element-relative smooth scrolling via CDP wheel events; auto-scrolls off-screen target containers into view. Supports `app`. |
| 8 | `browser_dialog` | Dialog & Human Oversight | Accepts, dismisses, or responds to JavaScript `alert`, `confirm`, and `prompt` dialogs with deduplicated session listeners. Supports `app`. |
| 9 | `browser_burst` | Mission & Automation | Atomic multi-step action pipeline execution in a single JSON-RPC round-trip (`app` propagated in `batch` mode). Supports `app`. |
| 10 | `browser_tabs` | Tabs & Windows | Full tab & window CRUD lifecycle (`open`, `switch`, `close`, `consolidate` with Tab Armor + URL normalization, `heal`). Specify `app` for desktop apps. |
| 11 | `browser_wait` | Wait, Timing & Safety | Blocks execution until DOM element, text, URL pattern, network idle, or stability is met (returns `success: false` on timeout). Supports `app`. |
| 12 | `browser_captcha` | Wait, Timing & Safety | Autonomous zero-API solving of Turnstile, reCAPTCHA, GeeTest, and hCaptcha challenges. Supports `app`. |
| 13 | `browser_thoughts` | Dialog & Human Oversight | Visual agent-to-user status HUD overlay (feedback banner or interactive question modal, 120s default timeout). |
| 14 | `browser_pointer` | Input & Interaction | Precision mouse control for hover flyouts (`hover_chain`), clicks, double-clicks, and drag-and-drop with `buttons: 1` and `end_ref` verification. Supports `app`. |
| 15 | `browser_select` | Input & Interaction | Selects single (`value`) or multiple (`values`) options in native `<select>` or custom ARIA/Radix/Shadcn dropdowns, or highlights text ranges (`mode: "text"`). Supports `app`. |
| 16 | `browser_fill` | Input & Interaction | Smart multi-field form batch completion across text inputs, radios, checkboxes, selects, and `grid_data` spreadsheets (`AA`+ columns). Supports `app`. |
| 17 | `browser_highlight` | Canvas & Visual Overlays | Zero-token visual CDP overlay highlights with `textContent` XSS safety and validated colors. Supports `app`. |
| 18 | `browser_upload` | Input & Interaction | File input attachment bypassing OS pickers via CDP `DOM.setFileInputFiles` with cached ActionMap reuse. Supports `app`. |
| 19 | `browser_find` | Vision & Reading | Fast in-page text search via a leaf-optimized TreeWalker returning clean CSS selectors with secret redaction on matched labels. Supports `app`. |
| 20 | `browser_storage` | Storage & Cookies | Validated `localStorage`/`sessionStorage` CRUD with secret redaction on `get`/`list` and 2,000-char per-value cap on `list`. Supports `app`. |
| 21 | `browser_network_intercept` | Network & Security | Escaped glob request mocking/blocking, Response-stage passthrough, clean listener teardown, and TLS/timing telemetry. Supports `app`. |
| 22 | `browser_console` | Vision & Reading | Reads/clears buffered console logs (`0`/`false` preserved, noise filtered across all paths, secrets redacted, 1,000-char entry cap). Supports `app`. |
| 23 | `browser_pdf` | Output & Media | Prints the active page to PDF with basename path-traversal guards, auto `.pdf` suffix, scaling, landscape mode, and secret masking. Supports `app`. |
| 24 | `browser_eval` | Script Evaluation | Evaluates JS in page context, auto-invokes bare zero-arg functions (`() => ...`), and recursively redacts secrets across objects/arrays. Supports `app`. |
| 25 | `browser_cookies` | Storage & Cookies | Cookie CRUD via CDP Network domain (`get` \| `list` \| `set` \| `delete`) with secret redaction on read and real delete error reporting. Supports `app`. |
| 26 | `browser_canvas` | Canvas & Visual Overlays | Export canvas pixels as Base64 PNG or execute coordinate drag paths (`buttons: 1`). Supports `app`. |
| 27 | `browser_scrape` | Vision & Reading | Structured data extraction via CSS or XPath selectors with unified retry preserving `multiple: false`, live `.value`, and secret redaction. Supports `app`. |
| 28 | `browser_snapshot` | Vision & Reading | Capture or restore complete MHTML snapshots with MHTML secret redaction, verified restore paths, and `pathToFileURL()`. Supports `app`. |
| 29 | `browser_screenshot` | Vision & Reading | Visual viewport or full-page capture (PNG/JPEG/base64) with secret masking and accurate scaled dimensions on >1280px viewports. Supports `app`. |
| 30 | `browser_viewport` | Navigation & Environment | Configures viewport dimensions, DPR, mobile mode, real CDP touch emulation, color scheme (`no-preference` clear), and Electron-safe reset. Supports `app`. |
| 31 | `browser_clipboard` | Dialog & Human Oversight | System clipboard R/W (text and/or base64 image), native write priority, macOS `Cmd+V` paste, and secret redaction on read. Supports `app`. |
| 32 | `browser_inspect` | Vision & Reading | Parallel CDP element inspection returning computed styles, box model, and event listeners with Shadow DOM fallback. Supports `app`. |
| 33 | `browser_automation` | Mission & Automation | Injects persistent background scripts with clean new-document teardown on `stop`, 100-entry mailbox cap, and recursive redaction on `poll`. Supports `app`. |
| 34 | `browser_recording` | Output & Media | Video screencast recording (`.webp`, `.gif`, `.webm`, `.mp4`) with `sessionId` path-traversal validation and listener cleanup on error. Supports `app`. |
| 35 | `browser_detect` | Tabs & Windows | CRITICAL INITIALIZATION TOOL. Detects local browsers and configured desktop apps (case-insensitive `app` match) with status, tabs, and port. |
| 36 | `browser_performance` | Performance & Vitals | Retrieves CDP metrics (`Performance.enable()`), parallel Core Web Vitals (FCP, LCP, CLS) with observer teardown, and single-eval memory/resource timings. Supports `app`. |
| 37 | `browser_office` | Office Documents | Parses Word (`.docx`), Excel (`.xlsx`), PDF, and CSV files (25MB cap, native `FileReader`, ZIP `word/`/`xl/` sniffing, secret redaction). Supports `app`. |
| 38 | `browser_emulate` | Navigation & Environment | Emulates validated network presets, CPU multipliers (`>= 1`), geolocation, User-Agent, and color scheme (`no-preference` clear). Supports `app`. |
| 39 | `browser_checkpoint` | Storage & Safety | Snapshot and restore browser state (`mode: 0o600` files, bounded restore load wait) into named checkpoints for rollback. Supports `app`. |
| 40 | `browser_pattern_learn` | Self-Learning & Heuristics | Read, register, update, and record execution outcomes for named workflow patterns and site quirks per origin. Use `action: "get"` to inspect site profiles. |

---

## 1. Vision & DOM Reading

### `browser_map`
High-density DOM tree snapshotter with volatile `w:NN` ref IDs. The foundational tool for reading and understanding page structure with zero prompt waste.

**Core 3.0 Capabilities:**
- **Entity & Container Binding**: Binds action buttons/inputs directly to parent cards, rows, or list items under `┌ [Container Header]` trees.
- **Active Modal & Dialog Hoisting**: Automatically detects and isolates active dialogs/modals at the top of the map under `╔═ ACTIVE DIALOG: "..." ═╗`.
- **Nav & Footer Cluster Collapsing**: Compresses cascades of repetitive navigation/footer links (4+ links) into compact `[w:5…w:24] 20 links: "Home" … "Terms"` summaries.
- **High-Density Unified Grammar**: Single-line format distinguishing `val:"..."`, `ph:"..."`, `FOCUSED`, `checked`, and `disabled` states.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `delta` | `boolean?` | Diff mode: returns only elements added, removed, or modified since the previous snapshot. |
| `prune` | `boolean?` | One-shot semantic compression: collapses repetitive elements and strips non-interactable noise. |
| `scope` | `string?` | Restricts extraction to a semantic landmark or selector: `"navigation"`, `"main_content"` (alias `"main"`), `"sidebar"`, `"form"`, `"modal"`, `"utility"`, or a CSS selector. |
| `query` | `string?` | Filters elements by accessible name, ARIA role, or label substring. |
| `visual` | `boolean \| "auto"?` | Set-of-Marks visual grounding. Injects numbered badges `[1]…[N]` and returns an annotated screenshot. Use `"auto"` for canvas/WebGL pages with < 5 DOM elements. |
| `ax_tree` | `boolean?` | Uses Chromium Accessibility Tree directly (essential for closed Shadow DOM and canvas SPAs). |
| `full` | `boolean?` | Return full markdown table format with bounding boxes instead of compact list. |
| `force` | `boolean?` | Force full DOM map rebuild even if loop detection says nothing changed. Bypasses skip guard and resets loop strikes. |
| `tab_id` | `string?` | Read a specific background tab ID (the `tabId` returned by `browser_tabs`). |
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
Fast in-page text search via a leaf-optimized, non-mutating TreeWalker shim returning clean CSS selectors. Filters out non-content elements (`<style>`, `<script>`, `<noscript>`, `<template>`) and internal Weavetab overlay hosts (`#wt-shadow-host`, `weavetab-host`, `[data-wt-ignore]`). Approximately 10x cheaper than `browser_map` when only checking for text presence or targeting elements by visible string. Channel/user prefixes (`#`, `@`) are stripped for token matching.

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
| `app` | `string?` | Target Electron desktop application. |

```typescript
browser_scrape({
  query: ".pricing-card",
  type: "css",
  attributes: ["data-plan", "textContent", "href"]
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
| `id` | `string?` | Volatile `w:NN` ref ID from `browser_map` (alias: `ref`). |
| `selector` | `string?` | CSS selector of target element (alias: `target`). |
| `label` | `string?` | Visible text label or `aria-label` of the target element. |
| `intent` | `string?` | Semantic intent for AI-assisted Memory Intent Intercept. |
| `backendNodeId` | `number?` | Raw CDP `backendNodeId` for direct hardware targeting. |
| `x` | `number?` | Raw X coordinate for positional clicks. |
| `y` | `number?` | Raw Y coordinate for positional clicks. |
| `include_map` | `boolean?` | Include an updated DOM map in the response (default `false`). |
| `force` | `boolean?` | Bypass pointer-event occlusion checks and click coordinates directly. |
| `tab_id` | `string?` | Target a specific background tab ID. |
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
| `clearFirst` | `boolean?` | Clear input field value before typing (alias: `clear`). |
| `clear` | `boolean?` | Alias for `clearFirst`. |
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
Host-isolated blind credential injection from encrypted local storage (`secrets.json`). Injects passwords, 2FA seeds, and sensitive credentials directly into input fields via CDP without exposing plaintext values to the AI context, audit logs, or DOM reads.

**Key Upgrades:**
- **Zero-Exposure In-Process Resolution**: The model passes only the key name (`envKey: "MY_KEY"`). The MCP server resolves the value in-process, enforces domain scoping, and blocks empty-hostname URLs (`file://`, `about:blank`).
- **Universal Selector Support**: Accepts direct CSS selectors (`#password`, `input[type='password']`, `.pwd-field`), exact ActionMap ref IDs (`w:5`), or `target: "focused"`.
- **Automatic DOM Hardening**: Injected elements are tagged with `data-wt-secret="true"`, instance `.value` getters are overridden with `[REDACTED]`, and symbol coercion/JSON serialization leaks are sealed.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `envKey` | `string` *(required)* | Key name stored in `secrets.json` (or `process.env`). |
| `id` | `string?` | Target element `w:NN` ref ID (alias: `ref`). |
| `target` | `string?` | Target element identifier or CSS selector (`"focused"`, selector, or ref ID). |
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
- **Google Sheets & Canvas Spreadsheet Grid Fill**: Supports typing directly into spreadsheet cell coordinates (including multi-letter columns like `AA1`) via `grid_data: [{ cell: "A1", value: "Revenue" }]` using a single AX tree fetch per batch.

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
    { ref: "w:12", value: "fy2ne" },
    { name: "email", value: "hello@fy2ne.me" },
    { label: "Role", value: "Maintainer" }
  ],
  submit: "w:18"
})
```

---

### `browser_select`
Selects single or multiple options from native `<select>` elements or custom ARIA/Radix/Shadcn dropdowns, or highlights a text range inside an element (`mode: "text"`).

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `id` | `string?` | Target element `w:NN` ref ID or CSS selector (aliases: `ref`, `target`, `selector`). |
| `nodeId` | `number?` | Raw CDP `backendNodeId`. |
| `value` | `string?` | Single option value or visible text to select (when `mode` is `"option"`). |
| `values` | `string[]?` | Multiple option values or visible labels for multi-select dropdowns. |
| `mode` | `"option" \| "text"?` | `"option"` (default) picks dropdown option(s); `"text"` highlights text inside an input, textarea, or DOM element. |
| `start` | `number?` | Start character offset when `mode: "text"` on an input/textarea. |
| `end` | `number?` | End character offset when `mode: "text"` on an input/textarea. |
| `app` | `string?` | Target Electron desktop application. |

```typescript
// Single option on native or custom dropdown
browser_select({ id: "w:19", value: "Enterprise" })

// Multi-select dropdown
browser_select({ id: "#tags", values: ["security", "cdp"] })

// Highlight text range inside an input/textarea
browser_select({ id: "w:14", mode: "text", start: 0, end: 12 })
```

---

### `browser_pointer`
Precision mouse control for hover flyouts, clicks, double-clicks, and drag-and-drop.

**Key Upgrades:**
- **Multi-Level `hover_chain`**: Traverse complex multi-level nested menus (e.g. Photoshop/Photopea `"File" → "Export As" → "PNG"`, Figma, or enterprise dashboards) in a single tool call without custom eval scripts.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `action` | `"hover" \| "move" \| "click" \| "double_click" \| "drag_and_drop" \| "hover_chain"?` | Mouse action type (default `"click"`, or `"hover_chain"` when `hover_chain` is provided). |
| `ref` | `string?` | Target `w:NN` ref ID (alias: `id`). |
| `selector` | `string?` | CSS selector of target element (alias: `target`). |
| `label` | `string?` | Target element label or text. |
| `x` / `y` | `number?` | Raw pointer coordinates (fallback). |
| `hover_chain` | `string[]?` | Array of ref IDs, selectors, or labels to hover sequentially (e.g. `["File", "Export As", "PNG"]`). |
| `chain` | `array?` | Advanced step array `{ action, ref, label, selector, x, y, holdMs }`. |
| `clickFinal` | `boolean?` | Whether to click the final element in `hover_chain` (default `true`; alias: `click_final`). |
| `end_ref` / `end_selector` | `string?` | Destination ref ID or CSS selector for `drag_and_drop` (aliases: `end_id`, `end_target`). |
| `end_x` / `end_y` | `number?` | Destination coordinates for `drag_and_drop`. |
| `waitForChild` | `string?` | CSS selector of a child element to wait for during `hover`. |
| `holdMs` | `number?` | Milliseconds to hold the pointer down during `hover`. |
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
- **Direct Key Dispatch**: Dispatches native CDP key events without artificial post-key delays.

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
- **Non-Blocking Scroll**: Skips redundant full DOM action map rebuilds after scrolling.
- **Direct Target Scrolling**: Supports scrolling specific container elements by `w:NN` ref ID.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `direction` | `"up" | "down" | "left" | "right"` | Scroll direction. |
| `distance` | `number?` | Scroll distance in pixels (default `400`). Aliases `pixels` and `amount` are accepted for compatibility. |
| `speed` | `"human" \| "read" \| "fast"?` | Scroll pacing profile. |
| `id` | `string?` | Target element `w:NN` ref ID or selector to scroll inside. |
| `app` | `string?` | Target Electron desktop application. |

---

### `browser_emulate`
Emulate environmental conditions over CDP: validated network throttling presets (`offline`, `slow3g`, `fast3g`, `4g`, `online`), validated CPU slowdown multipliers (`>= 1`), geolocation overrides, timezone IDs, `prefers-color-scheme` overrides (including `"no-preference"` reset), and custom User-Agent strings.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `network` | `string \| object?` | Throttling profile (`"offline" \| "slow3g" \| "fast3g" \| "4g" \| "online"`) or custom `{ latency, downloadThroughput, uploadThroughput }`. Unknown preset names are rejected. |
| `cpuThrottlingRate` | `number?` | CPU slowdown multiplier (`>= 1`, e.g. `2` = 2× slowdown, `4` = 4× slowdown, `1` = normal). |
| `geolocation` | `object?` | Override coordinates `{ latitude: number, longitude: number, accuracy?: number }`. |
| `timezoneId` | `string?` | Override browser timezone (e.g. `'America/New_York'`). |
| `colorScheme` | `"light" \| "dark" \| "no-preference"?` | Emulate `prefers-color-scheme` (`"no-preference"` clears the override). |
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
| `app` | `string?` | Target Electron desktop application. |

```typescript
browser_captcha({ action: "solve", timeout: 45000 })
```

---

## 5. Plugin Extensibility

External tools and specialized workflow bridges are authored using @weavetab/sdk and dynamically mounted into Weavetab. Core Weavetab MCP maintains 40 deterministic browser and desktop automation tools.

---

## 6. Enterprise Documents & Office

### `browser_office`
Parses and extracts structured tabular content, text paragraphs, and metadata from Word (`.docx`), Excel (`.xlsx`/`.xls`), PDF, and CSV files downloaded during browser sessions or fetched via URL (using native `FileReader`, 25MB size cap, ZIP `word/` vs `xl/` format sniffing, and session secret redaction).

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `action` | `"read" | "list"` *(required)* | Document parsing operation. |
| `file` | `string?` | Bare filename (e.g. `"financial_report.xlsx"`) inside the local downloads directory (no path separators). |
| `url` | `string?` | Authenticated browser session URL to document (capped at 25MB). |
| `max_rows` | `number?` | Maximum spreadsheet/table rows to parse (default `500`). |
| `max_chars` | `number?` | Maximum characters to return for PDF/Word text (default `50000`). |
| `app` | `string?` | Target Electron desktop application. |

```typescript
browser_office({
  action: "read",
  file: "financial_report.xlsx",
  max_rows: 100
})
```

---

## 7. Session Safety & Self-Learning

> Plugin lifecycle is not exposed as MCP tools. Plugins are loaded at server startup; there are no `list_plugins` or `load_plugin` tools.

### `browser_checkpoint`
Snapshot and restore browser state (cookies, localStorage, sessionStorage, and scroll/URL) into named checkpoints written with owner-only permissions (`mode: 0o600`) and bounded load waits on restore.

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
| Parameter | Type | Description |
|---|---|---|
| `app` | `string?` | Optional Electron app name to check exclusively (e.g. `"vscode"`, `"discord"`). |

```typescript
browser_detect()
browser_detect({ app: "vscode" })
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

## 9. Memory, Learning & Profiles

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
| `app` | `string?` | Target Electron desktop application. |

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

---

## 10. Built-in MCP Resources & Prompts

| Surface | Identifier | Description |
|---|---|---|
| Resource | `weavetab://active-tab` | JSON state (`attached`, `url`, `title`, `targetId`) of the currently attached tab (with secrets redacted). |
| Resource (per plugin) | `weavetab://plugins/<name>/instructions` | Exposed for plugins that declare `instructions` in `weavetab.json`. |
| Prompt | `page_context` (`/page_context`) | Injects current page state, detected framework, recent console errors, and lite DOM map. |
| Prompt | `agent` (`/agent`) | Switches the agent into autonomous mode (`browser_thoughts` disabled; no user-feedback pause). |



