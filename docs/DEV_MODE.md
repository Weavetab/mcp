# Weavetab Developer Mode (devMode) & Plugin Profiling Guide

This guide explains Developer Mode (`devMode`), how tool execution timing (`execution_ms`) works, and how it empowers **`weavetab-plugin` developers** and AI agents to profile performance.

---

## Enabling Developer Mode

Developer Mode can be enabled in two ways:

1. **Via Configuration (`~/.weavetab/config.json` or `.weavetab/config.json`)**:
   ```json
   {
     "devMode": true
   }
   ```

2. **Via Environment Variable**:
   ```bash
   WEAVETAB_DEV=1 node dist/index.js
   ```

---

## What Does `devMode` Add?

When `devMode` is active, Weavetab exposes rich execution metadata, visual debugging tools, and mission logging without altering underlying tool execution behavior.

### 1. `execution_ms` & Tool Performance Profiling

In `devMode`, every tool response automatically includes an **`execution_ms`** field:

```json
{
  "success": true,
  "execution_ms": 14,
  "result": { ... }
}
```

* **Purpose**: Measures the exact millisecond duration required to process and complete that specific tool call.
* **Essential for Plugin Developers**: Allows community developers building custom Weavetab plugins to profile their handlers, measure bottleneck latency, and optimize tool responsiveness.
* **Agent Context Awareness**: AI agents and users reading tool outputs can monitor tool performance in real time.

### 2. Extension Visual Overlays & Tool Calls

* **Extension Visuals**: Renders real-time tool execution badges and `toolcalls` counters directly within the extension overlay.
* **Trajectory & Hitbox Inspection**: Visualizes pointer paths, click target bounding boxes, and action status badges during execution.

### 3. Mission Logs (`/logs/`)

* For every completed mission, Weavetab generates a structured mission log file inside `/logs/` (`~/.weavetab/logs/`).
* Contains full step-by-step tool traces, `execution_ms` timing distributions, and action histories for auditing and debugging.

---

## Plugin Performance Profiling

Developer Mode is especially valuable for community developers creating Weavetab plugin packages.

* **Profiling Custom Tool Handlers**:
  When developing a plugin, enabling `devMode` (`WEAVETAB_DEV=1`) allows you to inspect the `execution_ms` timer on every custom tool response to benchmark performance and optimize your code before publishing.
* **Manifest & Permissions**:
  Plugins define their metadata, permissions, and entry points in a `weavetab.json` manifest.
* **Marketplace Screenshots (`/images/`)**:
  Plugins can include an `/images` directory with screenshots and logos for display on the official Weavetab Marketplace website (`website/`).

> 📖 For full details on building, packaging, and publishing plugins, see [docs/PLUGINS.md](PLUGINS.md).
