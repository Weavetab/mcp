# Weavetab MCP — AI Agent Developer Guide

This document is the universal specification for AI agents (Cursor, Antigravity, Claude Code, Copilot Workspace, Devin, OpenCode, Roo Code, Cline) contributing to or extending the Weavetab MCP server.

---

## Architectural Principles

1. **Direct CDP Transport**:
   * Weavetab connects directly to Chrome DevTools Protocol (CDP) via WebSocket (`127.0.0.1`).
   * **Do NOT introduce Puppeteer, Playwright, or Selenium wrapper abstractions**.
   * Supports both standard browsers (Chrome/Chromium) and **any Electron/desktop webview app** (Discord, VS Code, Antigravity, Figma, Obsidian, Slack, or local apps from source) via the generic `app` parameter and `electron` config mapping.

2. **Deterministic State & Token Efficiency**:
   * Use the **Semantic Delta Engine** for DOM snapshot diffing.
   * Tool responses must return concise, actionable JSON payloads with stable DOM reference IDs (`w:NN`).

3. **Security Constraints**:
   * **Blind Injection**: Never leak credentials into LLM context. `browser_type_secret` must sanitize inputs to `[REDACTED]`.
   * Enforce domain policy checks (top-level `policies` array in `~/.weavetab/config.json`) and RBAC permissions (`admin`, `operator`, `viewer`, `automation`, `system`).

4. **Plugin Surface Taxonomy (Tools, Commands, Utilities & `AGENTS.md`)**:
   * **MCP Tools (`tools`)**: Registered via `defineTool()` / `ctx.mcp.registerTool()`, gated by `permissions.tools.add`.
   * **CLI Commands (`commands`)**: Registered via `defineCommand()` / `ctx.cli.registerCommand()`, gated by `permissions.commands.add`. Executed from the terminal via `weavetab plugin use <pkg_or_alias> <command_or_tool_name> [--flags]` (or `weavetab use <pkg> <cmd>`).
   * **Utilities (`prompts` & `resources`)**: `/` **Prompts** (`definePrompt()`, gated by `permissions.prompts.add`) and `@` **Resources** (`defineResource()`, gated by `permissions.resources.add`) are grouped under **Utilities** on `/discover`.
   * **Bounded `AGENTS.md` Playbook**: Every plugin ships an `AGENTS.md` file at its package root (`<= 80` lines, `<= 3200` chars, enforced by `@weavetab/sdk` build/validate/preflight/publish). Connected AI agents can inspect installed plugins via the `weavetab://plugins` and `weavetab://plugins/<slug>/agents` MCP resources or `weavetab plugin agents [pkg]`.

---

## Build & Test Commands

* **Build Everything**:
  ```bash
  npm run build
  ```
* **Development Mode**:
  ```bash
  npm run dev
  ```
* **Run Tests**:
  ```bash
  npm test
  npm run test:unit
  npm run test:e2e
  ```

---

## Adding or Modifying MCP Tools

When adding or updating an MCP tool:
1. Define tool input schema using `zod` in `src/`.
2. Register the tool handler in the MCP server initialization.
3. Update tool definitions in `src/server.ts` and test assertions if tool list or capabilities change.
4. Add unit test coverage under `tests/unit/`.
