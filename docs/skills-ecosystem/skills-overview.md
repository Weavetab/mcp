---
title: "Skills Ecosystem"
description: "Drop-in agent skills and recipes from @weavetab/skills."
product: mcp
section: skills-ecosystem
icon: BrainCircuit
slug: skills-overview
---

# Weavetab Skills Ecosystem

The **`@weavetab/skills`** package provides drop-in operational directives and behavior skills for AI agents (Claude, Cursor, Windsurf, Copilot, Antigravity).

## Interactive Skills Installer

```bash
npx -y @weavetab/skills@latest
```

The interactive installer detects your IDE (`.agents`, `.cursorrules`, `.clinerules`, `.roocode`, etc.) and injects selected skills directly without workspace clutter.

---

## Available Skills Directory

- **CAPTCHA Evasion** (`.agents/skills/weavetab/captcha-evasion.md`) — Handling verification challenges cleanly.
- **File Upload** (`.agents/skills/weavetab/file-upload.md`) — Direct CDP file attachments via `browser_upload`.
- **Form Filling** (`.agents/skills/weavetab/form-filling.md`) — Multi-field smart form batch completion via `browser_fill`.
- **Guardrails** (`.agents/skills/weavetab/guardrails.md`) — Safety, domain policy, and secret containment guardrails.
- **Iframe Handling** (`.agents/skills/weavetab/iframe-handling.md`) — Navigating and acting inside nested iframes.
- **Infinite Scroll** (`.agents/skills/weavetab/infinite-scroll.md`) — Pagination and dynamic lazy loading.
- **Login Flow** (`.agents/skills/weavetab/login-flow.md`) — Blind credential injection via `secrets.json`.
- **Multi-Tab Management** (`.agents/skills/weavetab/multi-tab-management.md`) — Opening, switching, and isolating tabs.
- **SPA Navigation** (`.agents/skills/weavetab/spa-navigation.md`) — Client-side route changes in React/Vue/Angular.
- **Table Scraping** (`.agents/skills/weavetab/table-scraping.md`) — CSS & XPath structured tabular extraction.
