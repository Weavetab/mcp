---
title: "MCP Tools (46 Tools)"
description: "Complete reference of all 46 production-grade Weavetab automation tools."
product: mcp
section: tools
icon: Wrench
slug: tools
---

# MCP Tools Master Reference

Weavetab exposes **46 production-grade MCP tools** engineered for sub-10ms browser automation, visual inspection, desktop app orchestration, zero-API CAPTCHA solving, and human-like interaction.

Every tool adheres to a strict contract:
- **Zod schema validation** for all runtime arguments
- **`withSecurity()` pipeline** enforcing rate limits, domain policies, and RBAC roles
- **Structured audit logging** via `logAction()`
- **Zero-waste token models** utilizing volatile `w:NN` ref IDs, semantic deltas, and DOM pruning

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
| 10 | `browser_tabs` | Tabs & Windows | Full tab & window CRUD lifecycle management (open, switch, close, consolidate, heal). Supports `app`. |
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
| 36 | `browser_reset_loop_counter` | Wait, Timing & Safety | Resets the repetitive action strike counter to zero for long-running automated workflows. |
| 37 | `browser_detect` | Tabs & Windows | Detects installed local browsers and reports CDP feature support matrices. |
| 38 | `browser_performance` | Performance & Vitals | Retrieves Core Web Vitals (FCP, LCP, CLS) and detailed network resource timings. Supports `app`. |
| 39 | `browser_macro_compile` | Mission & Automation | Compiles recent action trails from session history into reusable `browser_burst` macros. |
| 40 | `github_analyze` | GitHub Intelligence | Analyzes GitHub repository structure, file trees, and READMEs without API token limits. |
| 41 | `github_read` | GitHub Intelligence | Reads raw file contents and specific line ranges from GitHub repositories. |
| 42 | `github_issues` | GitHub Intelligence | Lists, searches, and inspects GitHub issues and discussion threads. |
| 43 | `github_get_pr` | GitHub Intelligence | Inspects GitHub Pull Requests including changed files, diffs, and review comments. |
| 44 | `browser_office` | Office Documents | Parses Word (`.docx`), Excel (`.xlsx`), PDF, and CSV files into structured data. |
| 45 | `browser_emulate` | Navigation & Environment | Emulates network throttling (3G/4G/Offline), CPU slowdown, geolocation, and custom User-Agent. Supports `app`. |
| 46 | `list_plugins` | Plugins & Extensions | Inspects installed SDK plugins, loaded tool overrides, custom schemas, and capability manifests. |

---

## 1. Vision & DOM Reading

### `browser_map`
DOM tree snapshotter with volatile `w:NN` ref IDs. The foundational tool for reading and understanding page structure.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `delta` | `boolean?` | Diff mode: returns only elements added or modified since the previous snapshot (up to 97% token savings). |
| `prune` | `boolean?` | One-shot semantic compression: collapses repetitive elements and strips non-interactable noise. |
| `scope` | `enum?` | Restricts extraction to a semantic landmark: `"navigation"`, `"main_content"`, `"sidebar"`, `"form"`, `"modal"`, `"utility"`. |
| `query` | `string?` | Filters elements by accessible name, ARIA role, or label substring. |
| `ax_tree` | `boolean?` | Uses Chromium Accessibility Tree directly (essential for closed Shadow DOM and canvas SPAs). |
| `full` | `boolean?` | Return full markdown table format with bounding boxes instead of compact list. |
| `tab_id` | `string?` | Read a specific background tab ID. |
| `app` | `string?` | Target desktop Electron app name (e.g. `"discord"`, `"vscode"`, `"figma"`). |

```typescript
// Initial fast read with semantic pruning
browser_map({ prune: true })

// Efficient polling for changes
browser_map({ delta: true, prune: true })

// Inspect inputs inside Discord desktop app
browser_map({ app: "discord", scope: "main_content" })
```

---

### `browser_find`
Sub-5ms native CDP in-page text search via `Page.searchInPage`. Approximately 10× cheaper than `browser_map` when only checking for text presence.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `query` | `string` *(required)* | Text search query string. |
| `app` | `string?` | Target Electron desktop application. |

```typescript
browser_find({ query: "Order Confirmed" })
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
Physical click engine using Ghost Cursor Bézier curve trajectories. Resolves targets through a 5-layer fallback cascade: `ref` → `selector` → `label` → `intent` → `coords`.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `id` | `string?` | Volatile `w:NN` ref ID from `browser_map` (preferred). |
| `selector` | `string?` | CSS selector of target element. |
| `label` | `string?` | Visible text label of the target element. |
| `intent` | `string?` | Semantic intent for AI-assisted Memory Intent Intercept. |
| `app` | `string?` | Target Electron desktop application. |

```typescript
// Preferred: stable ref ID
browser_click({ id: "w:14" })

// Target desktop application
browser_click({ id: "w:8", app: "discord" })
```

---

### `browser_type`
Realistic humanized keystroke engine with temporal jitter (35–95ms), typing burst profiling, and stuck-input loop detection.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `text` | `string` *(required)* | Text string to type. |
| `id` | `string?` | Target `w:NN` ref ID. |
| `selector` | `string?` | CSS selector for target input. |
| `clearFirst` | `boolean?` | Clear input field value before typing. |
| `paste` | `boolean?` | Fast paste mode (recommended for tokens/strings > 8 chars). |
| `app` | `string?` | Target Electron desktop application. |

---

### `browser_type_secret`
**Blind Credential Injection** — Resolves passwords, API keys, and 2FA tokens server-side from `secrets.json`. Secrets are **never sent to the LLM context** and are permanently redacted as `[REDACTED]` in all subsequent DOM snapshots and audit logs.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `envKey` | `string` *(required)* | Key name in `secrets.json` (e.g. `"OKTA_PASSWORD"`). |
| `id` | `string?` | Target `w:NN` ref ID. |
| `target` | `string?` | CSS selector for target password/auth input. |

```typescript
browser_type_secret({ id: "w:8", envKey: "PROD_AUTH_TOKEN" })
```

---

## 3. Mission & Automation

### `browser_burst`
High-performance atomic action pipeline. Executes multiple sequential actions in a single MCP JSON-RPC round-trip, eliminating protocol latency overhead.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `steps` | `array` *(required)* | Array of compound macro step objects. |
| `batch` | `boolean?` | Run in batch mode. |
| `app` | `string?` | Target Electron desktop application context. |

```typescript
browser_burst({
  steps: [
    { action: "navigate_and_read", url: "https://example.com/login" },
    { action: "type_and_send", selector: "#username", text: "admin@corp.internal" },
    { action: "click_and_wait", selector: "#submit-btn" }
  ]
})
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

## 5. Enterprise Documents & Office

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

## 6. Plugins & Extensions

### `list_plugins`
Inspects all dynamically loaded Weavetab SDK plugins, active tool overrides, registered capability manifests, and isolated plugin storage directories.

**Parameters:**
| Parameter | Type | Description |
|---|---|---|
| `verbose` | `boolean?` | Return complete schema definitions and absolute file storage paths (default `false`). |

```typescript
list_plugins({ verbose: true })
```
