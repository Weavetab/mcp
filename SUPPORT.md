# Weavetab MCP Support & Community Resources

Thank you for building with **Weavetab**! Whether you are integrating Weavetab into your AI agent pipelines, building custom plugins, or reporting an issue, here is how and where to get support.

---

## 1. Documentation & Self-Help

Before opening an issue or asking for help, check our official references:

* **[Master Tool Reference](docs/tools/tools.md)** — Detailed parameters, signatures, and code examples for all 44 tools.
* **[Complete Documentation](docs/DOCUMENTATION.md)** — Architectural specs, security boundaries, and runtime configurations.
* **[Troubleshooting Guide](TROUBLESHOOTING.md)** — Solutions for common CDP connection, lock contention, and headless issues.
* **[Desktop & Electron Automation Guide](docs/desktop-automation/electron-apps.md)** — How to automate Discord, VS Code, Figma, and local Electron apps.

---

## 2. Asking Questions & Community Discussion

For general questions, design discussions, and sharing agent workflows:

* **[GitHub Discussions](https://github.com/weavetab/mcp/discussions)** — Ask architecture questions, show off agent integrations, and discuss new tool ideas.
* **Q&A Forum** — Search existing answered questions before posting a new thread.

> **Please do NOT use GitHub Issues for general support questions.** Keeping issues focused on bugs and feature requests ensures faster triage for everyone.

---

## 3. Reporting Bugs & Issues

If you encountered unexpected behavior or a bug in Weavetab:

1. **Check Existing Issues**: Search the [Issue Tracker](https://github.com/weavetab/mcp/issues) to see if the issue has already been reported.
2. **Include Environment Details**:
   - OS & version (Windows, macOS, Linux)
   - Node.js version (
ode -v)
   - Weavetab version (weavetab --version)
   - MCP Client (Claude Desktop, Cursor, Antigravity, Copilot Workspace, custom client)
   - Minimal reproduction script or MCP tool call sequence
3. **Include Debug Logs**: Run with DEBUG=weavetab:* or check ~/.weavetab-system/logs/.

👉 **[Open a Bug Report](https://github.com/weavetab/mcp/issues/new?template=bug_report.md)**

---

## 4. Reporting Security Vulnerabilities

Please do **NOT** report security vulnerabilities via public GitHub issues. 

Consult our **[Security Policy](SECURITY.md)** and report sensitive security issues directly to:
📧 **security@fy2ne.me** or **hello@fy2ne.me**

---

## 5. Enterprise & Custom Agent Consulting

Need dedicated support, custom MCP tool development, enterprise security auditing, or on-premise multi-agent orchestration?

* **Founder & Lead Maintainer**: Anas Khezaz (y2ne)
* **Contact**: [hello@fy2ne.me](mailto:hello@fy2ne.me)
* **Website**: [https://fy2ne.me](https://fy2ne.me)

---

## 6. Sponsoring & Financial Support

Weavetab is an open-source, AGPL-licensed Layer 0 automation engine. If Weavetab powers your production agents or saves your team engineering hours, consider supporting ongoing development:

* **[GitHub Sponsors](https://github.com/sponsors/fy2ne)** — Monthly or one-time developer sponsorship.

Your sponsorship funds continuous CDP compatibility updates, zero-API anti-bot heuristic research, and enterprise plugin development.
