---
title: "Desktop & Electron Apps"
description: "Native Layer 0 automation for VS Code, Discord, Figma, Slack, and any Electron app."
product: mcp
section: desktop-automation
badge: new
icon: AppWindow
slug: electron-apps
---

# Desktop & Electron Application Automation

Weavetab is a **universal Layer 0 agent runtime**. In addition to standard Chromium web browsing, Weavetab gives AI agents direct, native CDP control over **any desktop Electron application** — including Discord, VS Code, Figma, Slack, Obsidian, Postman, Notion, Spotify, and custom internal tools.

## How It Works

Because modern desktop applications are built on the Chromium/Electron framework, Weavetab can communicate with them directly over CDP WebSocket without requiring separate drivers or UI automation bridges.

```text
AI Agent (MCP) ──► withSecurity()
                     ├── (Default) ─────────► CDP:9222 ──► Google Chrome / Chromium
                     ├── (app: "discord") ──► CDP:9223 ──► Discord Desktop
                     ├── (app: "figma")   ──► CDP:9224 ──► Figma Desktop
                     └── (app: "vscode")  ──► CDP:9225 ──► VS Code Desktop
```

### Dual-Port Concurrency & Multi-Target Sessions
- **Concurrent Execution**: Web browser sessions and Electron desktop app sessions run side-by-side on independent CDP ports (e.g. port `9222` for Chrome, `9223` for Discord, `9224` for Figma).
- **Zero Session Clobbering**: Switching between a browser tab and a desktop app does not close, disconnect, or reload either target.
- **Unified Tool Interface**: Pass `"app": "<appName>"` to any Weavetab tool to target that desktop application. Omit `app` to target the active web browser.

---

## Interactive App Configurator

Build your `electron` block in the [Desktop app configurator](/mcp/desktop) — presets for Discord, VS Code, Figma, Slack and more, path / port / advanced formats, plus a copy-ready agent setup prompt. Then paste the block into your global `~/.weavetab/config.json`.

---

## 1. Configuring Desktop Apps in `config.json`

Add an `"electron"` object to your global `~/.weavetab/config.json` (the only config file Weavetab reads):

```json
{
  "electron": {
    "discord": "C:\\Users\\username\\AppData\\Local\\Discord\\app-<version>\\Discord.exe",
    "vscode": 9222,
    "figma": {
      "path": "C:\\Users\\username\\AppData\\Local\\Figma\\Figma.exe",
      "port": 9224,
      "url": "https://www.figma.com",
      "args": ["--enable-features=WebRTCPipeWireCapturer"]
    },
    "slack": "/Applications/Slack.app/Contents/MacOS/Slack",
    "obsidian": "/usr/bin/obsidian"
  }
}
```

### Configuration Formats Supported

| Format | Example | Description |
|---|---|---|
| **Executable Path String** | `"discord": "C:\\path\\to\\Discord.exe"` | Automatically launches the binary on an isolated port and dedicated profile. |
| **Port Number** | `"vscode": 9222` | Attaches directly to an already-running instance started with `--remote-debugging-port=9222`. |
| **Full Configuration Object** | `"figma": { "path": "...", "port": 9224, "url": "..." }` | Custom control over binary path, debug port, initial launch URL, custom profile directory, and startup CLI args. |

---

## 2. Security & Profile Isolation

Weavetab enforces enterprise-grade sandbox separation for all desktop applications:

1. **Dedicated User Profiles**: Automated sessions are assigned isolated data profiles under `~/.weavetab-system/apps/<appName>/`.
2. **Real AppData Protection**: Weavetab strictly enforces `assertNotRealElectronProfile` — attempting to target your primary OS user data directories (`%APPDATA%`, `~/Library/Application Support`, or `~/.config`) is blocked to protect your personal logins and local databases from accidental automation corruption.
3. **Lock & Mutex Isolation**: Dedicated lockfiles (`~/.weavetab-system/locks/<appName>.lock`) ensure concurrent agent operations never conflict.

---

## 3. Supported Desktop Schemes & Protocols

Weavetab automatically allows and whitelist-bypasses desktop internal protocols:
- `app://` (Electron internal resources)
- `vscode-webview://` / `vscode-file://` (VS Code extensions and webviews)
- `discord://` / `slack://` (Deep-links)
- `devtools://` / `chrome://` / `about:`
- `file:///` (Local files)

---

## 4. How Agents Interact with Desktop Apps

To target an Electron application, simply pass the `app` argument to any Weavetab tool:

### A. Inspect Desktop DOM Tree
```json
{
  "name": "browser_map",
  "arguments": {
    "app": "discord",
    "scope": "main_content"
  }
}
```

### B. Click & Type in Desktop Apps
```json
{
  "name": "browser_click",
  "arguments": {
    "ref": "w:42",
    "app": "discord"
  }
}
```

```json
{
  "name": "browser_type",
  "arguments": {
    "ref": "w:45",
    "text": "Automated build passed successfully! 🚀",
    "app": "discord"
  }
}
```

### C. Multi-Target Burst Orchestration
```json
{
  "name": "browser_burst",
  "arguments": {
    "app": "vscode",
    "steps": [
      { "action": "click_and_wait", "selector": ".monaco-editor" },
      { "action": "type_and_send", "text": "npm test" }
    ]
  }
}
```

---

## 5. Launching Existing Desktop Apps in Debug Mode

If you prefer to attach Weavetab to your existing desktop app instance:

```bash
# Launch VS Code with CDP debugging enabled
code --remote-debugging-port=9222

# Launch Obsidian with CDP debugging enabled
obsidian --remote-debugging-port=9225

# Launch Discord with CDP debugging enabled
discord --remote-debugging-port=9223
```
Then in your `config.json`, simply map `"vscode": 9222` or `"obsidian": 9225`.

---

## 6. Environment Discovery Handshake (`browser_detect`)

`browser_detect` is the foundational tool agents invoke upon initial engagement. It inspects local browsers and configured desktop applications, returning their real-time state:

```json
{
  "available": [
    { "engine": "chromium", "name": "Google Chrome", "path": "C:\\Program Files\\...\\chrome.exe" }
  ],
  "current": "chromium",
  "configuredApps": [
    {
      "name": "discord",
      "status": "running_no_debug",
      "configuredPath": "C:\\Users\\username\\AppData\\Local\\Discord\\app-1.0.9256\\Discord.exe"
    },
    {
      "name": "slack",
      "status": "connected",
      "port": 9222,
      "configuredPath": "C:\\Users\\username\\AppData\\Local\\slack\\app-4.38.125\\slack.exe",
      "activeTabs": [
        { "id": "PAGE_1", "title": "general - Slack", "url": "https://app.slack.com/client/..." }
      ]
    },
    {
      "name": "vscode",
      "status": "offline",
      "configuredPath": "C:\\Users\\username\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe"
    }
  ]
}
```

### Application Lifecycle States:
- **`connected`**: The app is running with CDP remote debugging active and Weavetab is attached. Agents can immediately operate tabs/windows using `"app": "<name>"`.
- **`running_no_debug`**: The app process is currently running on the OS, but was opened by the user without `--remote-debugging-port`. Weavetab alerts the agent that DOM interactions are blocked until the app is launched or restarted with debugging flags.
- **`offline`**: The process is not running. Calling `browser_navigate(app: "<name>")` launches and connects the app automatically.

### Windows Squirrel Auto-Path Resolution:
On Windows, applications like Discord and Slack install inside versioned folders (e.g. `Discord\app-1.0.9256\Discord.exe`) that change on every background update. Weavetab dynamically resolves the newest `app-1.0.xxxx` version at launch time, eliminating broken path errors after silent background updates.

---

## 7. Smart Domain Routing & Sticky Context

To ensure external AI agents do not accidentally trigger a web browser launch when intending to control an Electron application:

1. **Automatic Domain Routing**: When `browser_navigate` or `browser_tabs(action: "open")` receives an app domain (e.g. `discord.com`, `slack.com`, `linear.app`, `notion.so`), Weavetab automatically routes the target to the configured desktop application.
2. **Sticky App Sessions**: When an agent operates inside an Electron app, the target session context remains sticky. Subsequent calls to `browser_tabs` or DOM tools stick to that active desktop app without spawning an unwanted Chrome window.
3. **Explicit Browser Targeting**: When the agent specifically intends to use the web browser, passing `"app": "browser"` overrides desktop routing and directs operations to the web browser.

