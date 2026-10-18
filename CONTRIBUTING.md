# Contributing to Weavetab MCP

> **Version:** 2.5.1 | **Package:** `@weavetab/mcp` | **Last Updated:** August 2026

Thank you for your interest in contributing to Weavetab, the production-grade MCP server for AI-driven browser automation.

---

## Table of Contents

- [Reporting Bugs](#reporting-bugs)
- [Suggesting Enhancements](#suggesting-enhancements)
- [Pull Request Process](#pull-request-process)
- [Local Development](#local-development)
- [Adding New Tools](#adding-new-tools)
- [Coding Standards](#coding-standards)
- [Testing Requirements](#testing-requirements)
- [Documentation Standards](#documentation-standards)

---

## Reporting Bugs

Bugs are tracked as GitHub issues. When creating a bug report:

1. Use the provided `Bug Report` template
2. Include a clear, descriptive title
3. Provide exact steps to reproduce the behavior
4. Include relevant logs, error output, and environment details (OS, Node version, browser)
5. Attach a minimal reproduction case when possible

### Bug Report Template

```markdown
**Description**
A clear and concise description of what the bug is.

**To Reproduce**
Steps to reproduce the behavior:
1. Go to '...'
2. Click on '....'
3. Scroll down to '....'
4. See error

**Expected Behavior**
A clear and concise description of what you expected to happen.

**Screenshots**
If applicable, add screenshots to help explain your problem.

**Environment:**
 - OS: [e.g. Windows 11, macOS 14, Ubuntu 22.04]
 - Node Version: [e.g. 18.17.0]
 - Weavetab Version: [e.g. 2.5.1]
 - Browser: [e.g. Chrome 126, Edge 126]

**Additional Context**
Add any other context about the problem here.
```

---

## Suggesting Enhancements

Enhancement suggestions use the `Feature Request` template:

1. Describe the problem your feature would solve
2. Provide a step-by-step description of the proposed behavior
3. Explain why this enhancement is valuable to the broader Weavetab user base
4. Include examples of how the feature would be used by an AI agent

### Feature Request Template

```markdown
**Is your feature request related to a problem? Please describe.**
A clear and concise description of what the problem is. Ex. I'm always frustrated when [...]

**Describe the solution you'd like**
A clear and concise description of what you want to happen.

**Describe alternatives you've considered**
A clear and concise description of any alternative solutions or features you've considered.

**Additional context**
Add any other context or screenshots about the feature request here.
```

---

## Pull Request Process

1. Fork the repository and create your branch from `main`
2. Ensure tests pass: `npm run build` and any applicable test suites
3. Update documentation for any API changes
4. Verify code linting: `npm run build` (includes TypeScript compilation)
5. Submit the pull request with a clear description of changes

### Commit Style

We follow conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. Each commit should represent a single logical change.

**Examples:**
- `feat: add browser_canvas tool for image data extraction`
- `fix: resolve stuck detection false positives in React apps`
- `docs: update README with new tool categories`
- `refactor: optimize delta engine for large DOM trees`
- `test: add integration tests for browser_burst macro steps`

### PR Description Template

```markdown
## Description
Brief description of changes made in this PR.

## Type of Change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Testing
Describe the tests you ran to verify your changes:
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] Manual testing performed

## Checklist
- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
```

---

## Local Development

Weavetab uses `esbuild` for UI bundling and `tsc` for server compilation.

### Prerequisites

- Node.js 18 or higher
- Chromium-based browser (Chrome, Edge, Brave, etc.)

### Setup

```bash
# Clone the repository
git clone https://github.com/weavetab/mcp.git
cd mcp

# Install dependencies
npm install

# Run in development mode (TSX watcher)
npm run dev

# Build the project
npm run build

# Run tests
npm test              # All tests
npm run test:unit     # Unit tests only
npm run test:e2e      # End-to-end smoke test

# View CLI help
node dist/index.js help
```

### Project Structure

```
src/
├── cdp/            # Chrome DevTools Protocol bridge
│   ├── bridge.ts       # Browser process launcher
│   ├── connector.ts    # CDP connection pool & session init
│   ├── walker.ts       # DOM enumeration & AX tree parsing
│   ├── pruner.ts       # Semantic DOM compression
│   ├── lock.ts         # Two-factor browser lock system
│   ├── finder.ts       # Cross-platform browser detection
│   ├── profiles.ts     # Session profile management
│   ├── helpers.ts      # Extension communication helpers
│   ├── confirm.ts      # Element diffing/confirmation
│   ├── extension.ts    # Chrome extension management
│   ├── retry.ts        # CDP operation retry with backoff
│   ├── ref_cache.ts    # Unique Reference Cache for element stability
│   ├── websocket_transport.ts  # WebSocket MCP transport
│   ├── omni_broker.ts  # Omni channel broker for extension communication
│   ├── security.ts     # CDP-level security checks
│   ├── verify.ts       # Element verification after actions
│   └── label_cache.ts  # Label caching for performance
├── intelligence/   # Session memory, trail, hints, vision
│   ├── sessionMemory.ts  # Per-domain profiles & framework detection
│   ├── trail.ts          # Action history & loop detection
│   ├── hints.ts          # Persistent domain knowledge (Rule 16)
│   ├── vision.ts         # Local pixel analysis fallback
│   └── intent.ts         # Intent-based action resolution
├── sensors/        # Telemetry, mutations, pacing, thoughts
│   ├── network.ts        # CDP network event interception
│   ├── mutations.ts      # DOM mutation observation
│   ├── pacing.ts         # Human pacing & timing telemetry
│   ├── guard.ts          # Wait condition guards
│   ├── thoughts.ts       # Thought HUD status messages
│   ├── wait.ts           # Advanced wait conditions
│   └── operation_monitor.ts  # Operation monitoring & diagnostics
├── security/       # Domain blacklist, rate limiter, RBAC, secrets
│   ├── blacklist.ts      # Domain policy engine
│   ├── filter.ts         # Input sanitization & prompt injection filter
│   ├── guard.ts          # Root guard & storage blocker
│   ├── ratelimit.ts      # Rate limiter
│   └── secrets.ts        # Blind Injection & secret tracker
├── state/          # Delta engine, agent state, session registry, cache
│   ├── delta.ts          # Semantic snapshot diffing
│   ├── agent.ts          # Agent state machine (idle/weaving/stuck)
│   ├── session.ts        # SessionRegistry & tab lifecycle
│   └── cache.ts          # Mutation observer cache
├── tools/          # Individual tool implementations (41 tools)
│   ├── read.ts           # browser_map
│   ├── navigate.ts       # browser_navigate
│   ├── click.ts          # browser_click
│   ├── type.ts           # browser_type
│   ├── type_secret.ts    # browser_type_secret
│   ├── key.ts            # browser_key
│   ├── scroll.ts         # browser_scroll
│   ├── pointer.ts        # browser_pointer
│   ├── select.ts         # browser_select
│   ├── fill.ts           # browser_fill
│   ├── upload.ts         # browser_upload
│   ├── tabs.ts           # browser_tabs
│   ├── dialog.ts         # browser_dialog
│   ├── thought.ts         # browser_thoughts
│   ├── wait.ts           # browser_wait
│   ├── burst.ts          # browser_burst
│   ├── automation.ts     # browser_automation
│   ├── find.ts           # browser_find
│   ├── inspect.ts        # browser_inspect
│   ├── highlight.ts      # browser_highlight
│   ├── canvas.ts         # browser_canvas
│   ├── clipboard.ts      # browser_clipboard
│   ├── console.ts        # browser_console
│   ├── cookies.ts        # browser_cookies
│   ├── storage.ts        # browser_storage
│   ├── snapshot.ts       # browser_snapshot
│   ├── screenshot.ts     # browser_screenshot
│   ├── pdf.ts            # browser_pdf
│   ├── eval.ts           # browser_eval
│   ├── viewport.ts       # browser_viewport
│   ├── network_intercept.ts  # browser_network_intercept
│   ├── scrape.ts         # browser_scrape
│   ├── recording.ts      # browser_recording
│   ├── browser_detect.ts # browser_detect
│   ├── performance.ts    # browser_performance
│   └── integration.test.ts
├── overlay/        # Shadow DOM UI injector
│   ├── injector.ts       # Overlay installation & re-injection
│   ├── ghost.ts          # Ghost cursor animation
│   └── bubble.ts         # Thought bubble HUD
├── audit/          # Structured logging & telemetry
│   ├── logger.ts         # Mission log files (mission_<timestamp>.log, .jsonl)
│   └── telemetry.ts      # Event broadcasting
├── plugin/         # Plugin interface and loader
│   ├── interface.ts      # WeavetabPlugin type definition
│   └── loader.ts         # Dynamic plugin discovery
├── config/         # Configuration management
│   └── loader.ts         # Multi-source merge, live reload, project detection
├── cli/            # CLI utilities
│   └── updater.ts        # Version check & update notifications
├── ui/             # CLI UI components (esbuild-bundled)
├── lifecycle/      # Mission lifecycle management
│   └── mission_manager.ts # Mission coordination
├── anticaptcha/   # CAPTCHA detection and solving
│   ├── detector.ts       # CAPTCHA detection logic
│   ├── solver.ts         # CAPTCHA solving strategies
│   └── integration.ts    # CAPTCHA integration
├── server.ts       # MCP server entry point (41 tool registrations)
└── index.ts        # CLI entry point (config wizard, reset, main UI)
```

---

## Adding New Tools

If you are contributing a new MCP tool, ensure it meets the following requirements:

1. **Return structured errors**: On failure, return a `WeaveError` object with a descriptive message
2. **Emit audit logs**: Use `logAction()` and `logActionStructured()` for every invocation
3. **Respect security policies**: Call `checkDomain()` and `isToolAllowedInMode()` for domain/RBAC enforcement
4. **Optimize for latency**: Target sub-10ms CDP execution without unnecessary DOM roundtrips
5. **Support multi-tab**: Accept an optional `tab_id` parameter for cross-tab execution where applicable (the server maps the public `tabId` argument onto it)
6. **Define a Zod schema**: Every parameter must be typed with Zod for MCP schema generation
7. **Register in server.ts**: Import the handler and add a `server.tool()` registration call
8. **Update docs**: Add the tool to `docs/TOOLS.md` and `README.md` tool category table

### Tool Registration Pattern

```typescript
// src/tools/my_tool.ts
import CDP from "chrome-remote-interface";
import { logAction } from "../audit/logger.js";
import { checkDomain } from "../security/blacklist.js";
import type { Config } from "../config/loader.js";

export interface MyToolResult {
  success: boolean;
  data: unknown;
}

export async function myTool(
  session: CDP.Client,
  args: { param1: string; param2?: number },
  config: Config
): Promise<MyToolResult> {
  // Security check
  const domainCheck = checkDomain(config);
  if (!domainCheck.allowed) {
    return { success: false, data: domainCheck.reason };
  }

  // Audit log
  logAction("my_tool", "unknown", JSON.stringify(args));

  // Implementation
  try {
    // Your CDP logic here
    const result = await session.Runtime.evaluate({
      expression: `/* your code */`,
      returnByValue: true
    });

    return { success: true, data: result.result?.value };
  } catch (error) {
    return { 
      success: false, 
      data: error instanceof Error ? error.message : String(error) 
    };
  }
}
```

```typescript
// src/server.ts
import { myTool } from "./tools/my_tool.js";

// In the main server setup
server.tool(
  "browser_my_tool",
  "WHAT: Brief description of what this tool does | WHEN: When to use this tool | CANNOT: Limitations | EXAMPLE: browser_my_tool({ param1: 'value' })",
  {
    param1: z.string().describe("Description of param1"),
    param2: z.number().optional().describe("Description of param2")
  },
  async (args) => {
    try {
      return await withSecurity(config, "browser_my_tool", async (session, liveConfig) => {
        const result = await myTool(session, args, liveConfig);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      });
    } catch (e) { return wrapError(e); }
  }
);
```

---

## Coding Standards

### TypeScript Guidelines

- Use strict TypeScript compilation (`strict: true` in tsconfig.json)
- Prefer explicit type annotations over `any`
- Use `interface` for object shapes, `type` for unions/primitives
- Avoid `any` — use `unknown` with type guards when necessary
- Use async/await over Promise chains
- Prefer `const` over `let` when possible

### Error Handling

- Always wrap CDP calls in try-catch blocks
- Return structured `WeaveError` objects for tool failures
- Include descriptive error messages with context
- Log errors using the audit system before throwing

### Performance Guidelines

- Target sub-10ms latency for CDP operations
- Minimize DOM roundtrips — batch operations when possible
- Use caching for repeated operations
- Avoid blocking the event loop
- Profile performance-critical paths

### Security Guidelines

- Always check domain policies before executing sensitive operations
- Validate all user inputs
- Never log sensitive data (passwords, tokens)
- Use Blind Injection for credential handling
- Respect RBAC permissions

---

## Testing Requirements

### Unit Tests

- Unit tests should be in `tests/unit/` directory
- Use Node.js built-in test runner
- Mock CDP connections for isolated testing
- Test both success and failure paths
- Aim for >80% code coverage

### Integration Tests

- Integration tests should be in `tests/integration/` directory
- Test real CDP interactions with a local browser
- Clean up browser sessions after tests
- Test cross-tool interactions
- Verify security policies are enforced

### Test Structure

```typescript
// tests/unit/my_tool.test.ts
import { describe, it, expect } from "node:test";
import { myTool } from "../../src/tools/my_tool.js";

describe("myTool", () => {
  it("should handle valid input", async () => {
    const mockSession = createMockSession();
    const result = await myTool(mockSession, { param1: "test" }, mockConfig);
    expect(result.success).toBe(true);
  });

  it("should handle invalid input", async () => {
    const mockSession = createMockSession();
    const result = await myTool(mockSession, { param1: "" }, mockConfig);
    expect(result.success).toBe(false);
  });
});
```

---

## Documentation Standards

### Tool Documentation

Every tool must include:

1. **WHAT**: A one-sentence description of what the tool does
2. **WHEN**: When to use the tool (conditions, use cases)
3. **CANNOT**: Limitations and edge cases
4. **EXAMPLE**: A concrete example usage

Format:
```
WHAT: <description> | WHEN: <usage guidance> | CANNOT: <limitations> | EXAMPLE: <example>
```

### API Documentation

- Update `docs/TOOLS.md` with new tools
- Update `README.md` tool category table
- Update `docs/DOCUMENTATION.md` if architecture changes
- Include parameter descriptions with types
- Provide return value structure

### Code Comments

- Comment complex algorithms and business logic
- Document non-obvious security considerations
- Explain performance-critical optimizations
- Include TODO/FIXME comments for future work
- Use JSDoc for public functions

---

## Release Process

### Pre-Release Checklist

- [ ] All tests pass
- [ ] Documentation is updated
- [ ] Version number is incremented in package.json
- [ ] CHANGELOG.md is updated
- [ ] Security audit is performed
- [ ] Performance benchmarks are run
- [ ] Breaking changes are documented

### Release Steps

1. Update version in `package.json`
2. Update CHANGELOG.md
3. Create git tag: `git tag v2.5.1`
4. Push tag: `git push origin v2.5.1`
5. Publish to NPM: `npm publish`
6. Create GitHub release

---

## Getting Help

If you need help contributing:

- **GitHub Issues**: Use for bug reports and feature requests
- **GitHub Discussions**: Use for questions and community discussion
- **Email**: conduct@weavetab.dev for Code of Conduct matters
- **Security**: security@weavetab.dev for security vulnerabilities

---

## License

By contributing to Weavetab, you agree that your contributions will be licensed under the AGPL-3.0 license.
