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

## Interactive App Configurator & Agent Generator

Use the interactive configurator below to customize your desktop applications. Select presets or add custom apps, toggle between executable path strings, remote debug ports, or advanced objects, and copy the ready-to-use JSON or an automated setup prompt for your AI coding agent:

```electron-configurator
```

---

## 1. Configuring Desktop Apps in `config.json`

Add an `"electron"` object to your local `./.weavetab/config.json` or global `~/.weavetab/config.json`:

```json
{
  "electron": {
    "discord": "C:\\Users\\username\\AppData\\Local\\Discord\\app-1.0.9175\\Discord.exe",
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
