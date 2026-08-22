# Weavetab MCP Tool Reference

> **Version:** 2.5.0 | **Total Registered Tools:** 45 | **Architecture:** Layer 0 Direct CDP & Extension Bridge

Weavetab provides 45 production-grade MCP tools engineered for browser automation, desktop/Electron application control (Discord, Slack, VS Code, Antigravity, Figma, Obsidian, etc.), GitHub repository analysis, Office document parsing, and deep web inspection.

> [!TIP]
> **Universal `app` Parameter:** All browser tools accept an optional `app?: string` argument to target any configured Electron desktop application or locally hosted source project without launching or interfering with your default web browser.

---

## Tool Directory

| # | Tool Name | Category | Description | Key Capabilities & Parameters |
| :--- | :--- | :--- | :--- | :--- |
| 1 | `browser_map` | `vision` | DOM tree snapshotter with volatile ref IDs (`w:NN`). For complex SPAs, supports delta diffing, semantic pruning, and AX tree fallback. | `delta: boolean` (up to 97% token reduction), `scope: string`, `query: string`, `force: boolean` |
| 2 | `browser_navigate` | `navigation` | Navigates to a URL with blocklist checks, network idle wait, and `weavetab://` scheme support. | `url: string`, `timeoutMs?: number` |
| 3 | `browser_click` | `input` | Physical click engine using Bézier curve kinematics (Ghost Cursor) and multi-stage fallback targeting (`ref` -> `selector` -> `label` -> `intent` -> `coords`). | `ref?: string`, `selector?: string`, `label?: string`, `coords?: [number, number]` |
| 4 | `browser_type` | `input` | Keystroke dispatch with humanized temporal jitter, stuck-input monitoring, and `clearFirst` support. | `ref?: string`, `text: string`, `clearFirst?: boolean` |
| 5 | `browser_type_secret` | `input` | Blind credential injection from environment variables or secrets store without exposing values to LLM context (`[REDACTED]`). | `envVar: string`, `ref?: string`, `selector?: string` |
| 6 | `browser_key` | `input` | Presses native key combinations (Ctrl, Alt, Shift, Meta, Enter, Tab, Escape, etc.). | `key: string`, `modifiers?: string[]` |
| 7 | `browser_scroll` | `input` | Smooth directional scrolling or scroll-to-element centering via CDP wheel events. | `direction?: "down" \| "up" \| "left" \| "right"`, `amount?: number`, `ref?: string` |
| 8 | `browser_dialog` | `dialog` | Accepts, dismisses, or responds to JS `alert`, `confirm`, and `prompt` dialogs. | `action: "accept" \| "dismiss"`, `promptText?: string` |
| 9 | `browser_burst` | `execution` | Atomic multi-step action pipeline execution in a single JSON-RPC round-trip. | `steps: Array<MacroStep>` (`navigate_and_read`, `type_and_send`, `click_and_wait`, etc.) |
| 10 | `browser_tabs` | `tabs` | Full tab and window CRUD lifecycle management (open, switch, close, list, consolidate, heal). | `action: "list" \| "open" \| "switch" \| "close" \| "consolidate" \| "heal" \| "list_windows" \| "focus_window"`, `url?: string`, `tabId?: number` |
| 11 | `browser_wait` | `navigation` | Pause until DOM element, text, URL, network idle, or DOM stability condition is met. | `condition: "element" \| "text" \| "url" \| "stable" \| "network" \| "auto"`, `target?: string`, `timeoutMs?: number` |
| 12 | `browser_captcha` | `security` | Autonomous detection and solving of turnstile, reCAPTCHA, and hCaptcha challenges. | `action: "detect" \| "solve" \| "status"`, `timeoutMs?: number` |
| 13 | `browser_thoughts` | `overlay` | Visual agent-to-user status HUD overlay (feedback banner or interactive question box). | `mode: "feedback" \| "question"`, `message: string`, `options?: string[]` |
| 14 | `browser_pointer` | `input` | Precision mouse pointer control including hover flyout triggers and drag-and-drop. | `action: "hover" \| "click" \| "double_click" \| "drag_and_drop"`, `ref?: string`, `targetRef?: string`, `waitForChild?: boolean` |
| 15 | `browser_select` | `input` | Selects native dropdown options by text or value, firing framework-safe synthetic events. | `ref?: string`, `value?: string`, `label?: string` |
| 16 | `browser_fill` | `input` | Smart multi-field form completion across text inputs, radios, checkboxes, and dropdowns. | `fields: Array<{ ref?: string, selector?: string, value: string }>` |
| 17 | `browser_plan` | `overlay` | Real-time task dashboard HUD panel rendered inside isolated Shadow DOM overlay. | `action: "create" \| "update" \| "clear"`, `tasks?: Array<{ id: string, title: string, status: "pending" \| "in_progress" \| "done" \| "failed" }>` |
| 18 | `browser_highlight` | `overlay` | Temporary visual CDP overlay highlights over target elements without DOM mutations. | `ref?: string`, `selector?: string`, `color?: string`, `durationMs?: number` |
| 19 | `browser_upload` | `input` | Direct file input upload bypassing OS file pickers via CDP `DOM.setFileInputFiles`. | `ref?: string`, `selector?: string`, `files: string[]` |
| 20 | `browser_find` | `vision` | Sub-5ms CDP text search without full DOM walk overhead. Zero token waste. | `query: string`, `caseSensitive?: boolean` |
| 21 | `browser_storage` | `storage` | Key-value store management for `localStorage` and `sessionStorage`. | `action: "get" \| "set" \| "clear" \| "remove"`, `type: "local" \| "session"`, `key?: string`, `value?: string` |
| 22 | `browser_network_intercept` | `network` | Request mocking, URL pattern blocking, and network timing/TLS diagnostic extraction. | `action: "mock" \| "block" \| "clear" \| "get_logs"`, `pattern?: string`, `response?: object` |
| 23 | `browser_console` | `inspection` | Sub-5ms access to buffered console API outputs, exceptions, and network errors. | `action: "get" \| "clear"`, `minLevel?: "log" \| "warn" \| "error"` |
| 24 | `browser_pdf` | `output` | Generates a PDF printout of the active page with layout and page range controls. | `landscape?: boolean`, `printBackground?: boolean`, `pageRanges?: string`, `outputPath?: string` |
| 25 | `browser_eval` | `evaluation` | Evaluates arbitrary JavaScript expressions directly in the main frame JS context. | `expression: string`, `awaitPromise?: boolean` |
| 26 | `browser_cookies` | `storage` | Full CRUD operations for browser cookies via CDP Network domain. | `action: "get" \| "set" \| "clear" \| "remove"`, `name?: string`, `value?: string`, `domain?: string` |
| 27 | `browser_canvas` | `vision` | Export canvas pixel data as Base64 PNG or execute coordinate gesture paths on charts/games. | `action: "get_image" \| "draw"`, `ref?: string`, `path?: Array<[number, number]>` |
| 28 | `browser_scrape` | `vision` | High-speed structured data extraction via CSS or XPath selectors in a single evaluation step. | `selector: string`, `attributes?: string[]`, `isXpath?: boolean` |
| 29 | `browser_snapshot` | `vision` | Capture or restore an MHTML snapshot (DOM + inline assets) for offline archival or verification. | `action: "capture" \| "restore"`, `filePath?: string` |
| 30 | `browser_screenshot` | `vision` | Visual screenshot capture in PNG or JPEG format with full-page and bounding box support. | `fullPage?: boolean`, `format?: "png" \| "jpeg"`, `quality?: number`, `clip?: object` |
| 31 | `browser_viewport` | `emulation` | Viewport dimensions, device scale factor, touch support, geolocation, and locale overrides. | `width?: number`, `height?: number`, `deviceScaleFactor?: number`, `isMobile?: boolean` |
| 32 | `browser_clipboard` | `interaction` | Plaintext and Base64 image reading/writing to the system clipboard. | `action: "read" \| "write"`, `text?: string` |
| 33 | `browser_inspect` | `inspection` | Deep DOM element inspection returning computed styles, box model, and attached event listeners. | `ref?: string`, `selector?: string` |
| 34 | `browser_automation` | `execution` | Injects self-running background tracking scripts into the page context. | `action: "inject" \| "remove" \| "list"`, `scriptName: string`, `code?: string` |
| 35 | `browser_recording` | `output` | Records browser session video screencasts into `.webp`, `.gif`, `.webm`, or `.mp4`. | `action: "start" \| "stop" \| "status"`, `fps?: number`, `format?: "webp" \| "gif" \| "webm" \| "mp4"` |
| 36 | `browser_reset_loop_counter` | `safety` | Resets the repetitive action strike counter to zero for long-running workflows. | `reason: string` |
| 37 | `browser_detect` | `system` | Detects installed local browsers and reports CDP feature support matrices across engines. | `target?: "chromium" \| "firefox" \| "webkit" \| "all"` |
| 38 | `browser_performance` | `performance` | Retrieves Core Web Vitals (FCP, LCP, CLS) and network resource timing breakdowns. | `includeResourceTimings?: boolean` |
| 39 | `browser_macro_compile` | `macro` | Compiles recent action trails into reusable `browser_burst` macro sequences. | `maxSteps?: number`, `macroName?: string` |
| 40 | `github_analyze` | `github` | Analyzes GitHub repository structure, file trees, and README content without API rate limits. | `owner: string`, `repo: string`, `branch?: string` |
| 41 | `github_read` | `github` | Reads raw file contents from public or private GitHub repositories. | `owner: string`, `repo: string`, `path: string`, `ref?: string` |
| 42 | `github_issues` | `github` | Lists, searches, and fetches GitHub issue details and discussion threads. | `owner: string`, `repo: string`, `action: "list" \| "get" \| "search"`, `issueNumber?: number` |
| 43 | `github_get_pr` | `github` | Inspects GitHub Pull Requests including changed files, diffs, and review comments. | `owner: string`, `repo: string`, `prNumber: number` |
| 44 | `browser_office` | `office` | Parses and extracts structured content/tables from Word (`.docx`), Excel (`.xlsx`), and PDF documents. | `action: "parse" \| "list" \| "search"`, `filePath: string` |
| 45 | `browser_emulate` | `emulation` | Advanced network throttling, offline mode, user-agent spoofing, and CPU throttling. | `networkProfile?: "offline" \| "3g_slow" \| "3g_fast" \| "4g"`, `cpuThrottlingRate?: number`, `userAgent?: string` |

---

## Detailed Tool Guidance & Examples

### 1. High-Efficiency Data Extraction
When extracting tabular data or structured text from a webpage, prefer **`browser_scrape`** or **`browser_find`** over `browser_map` to save 95%+ context tokens:
```json
{
  "name": "browser_scrape",
  "arguments": {
    "selector": "table.pricing-table tr",
    "attributes": ["innerText", "data-plan-id"]
  }
}
```

### 2. Multi-Action Pipeline Chaining
To reduce JSON-RPC transport overhead, chain repetitive form inputs and navigations into a single **`browser_burst`** request:
```json
{
  "name": "browser_burst",
  "arguments": {
    "steps": [
      { "action": "navigate_and_read", "url": "https://example.com/login" },
      { "action": "type_and_send", "ref": "w:12", "text": "user@example.com" },
      { "action": "click_and_wait", "ref": "w:15" }
    ]
  }
}
```

### 3. Blind Credential Injection
For enterprise security, inject secrets without exposing raw password text to the AI model logs or context stream:
```json
{
  "name": "browser_type_secret",
  "arguments": {
    "envVar": "WORKFLOW_AUTH_TOKEN",
    "selector": "#api-key-input"
  }
}
```

### 4. Desktop & Electron Application Automation
Automate desktop applications (Discord, Slack, VS Code, Antigravity, Figma, Obsidian, or local projects from source) using the `app` parameter:

```json
// 1. Target desktop app workbench tabs/windows
{
  "name": "browser_tabs",
  "arguments": {
    "action": "list",
    "app": "antigravity"
  }
}

// 2. Map DOM and click desktop buttons
{
  "name": "browser_click",
  "arguments": {
    "ref": "w:12",
    "app": "antigravity"
  }
}

// 3. Type into Electron desktop chat or editors
{
  "name": "browser_type",
  "arguments": {
    "ref": "w:25",
    "text": "Sent via Weavetab Layer 0 CDP!",
    "app": "discord"
  }
}
```

---

*Updated & verified for Weavetab v2.5.0.*
