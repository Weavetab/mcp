# Weavetab MCP — AI Agent Developer Guide

This document is the universal specification for AI agents (Cursor, Antigravity, Claude Code, Copilot Workspace, Devin, OpenCode, Roo Code, Cline) contributing to or extending the Weavetab MCP server.

---

## Architectural Principles

1. **Layer 0 Direct CDP**:
   * Weavetab connects directly to Chrome DevTools Protocol (CDP) via WebSocket (`127.0.0.1`).
   * **Do NOT introduce Puppeteer, Playwright, or Selenium wrapper abstractions**.

2. **Deterministic State & Token Efficiency**:
   * Use the **Semantic Delta Engine** for DOM snapshot diffing.
   * Tool responses must return concise, actionable JSON payloads with stable DOM reference IDs (`w:NN`).

3. **Security Constraints**:
   * **Blind Injection**: Never leak credentials into LLM context. `browser_type_secret` must sanitize inputs to `[REDACTED]`.
   * Enforce domain policy checks (`~/.weavetab/policy.json`) and RBAC permissions (`admin`, `system`, `viewer`, `automation`).

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
3. Update [mcp.json](file:///c:/Users/fy2ne/Music/Weavetab/MCP/mcp.json) and [server.json](file:///c:/Users/fy2ne/Music/Weavetab/MCP/server.json) metadata if tool list or capabilities change.
4. Add unit test coverage under `tests/unit/`.
