#!/usr/bin/env node
// src/index.ts — Weavetab V3 CLI entrypoint

import { assertNotRoot } from "./security/guard.js";
import { loadConfig, saveConfig, getCachedConfig, GLOBAL_CONFIG_PATH, GLOBAL_CONFIG_DIR, getConfigMode, getConfigAttachPort, getConfigAgentId, getConfigBrowserType, getConfigBrowserPath, getConfigRole, getConfigHeadless, getConfigExtension, getElectronApps, getConfigMaxTabs, getConfigSessionTimeout, getConfigNavigationTimeout, getConfigIdleTimeout, getConfigMaxActionsPerMinute, getConfigTelemetry, getConfigBlock, getConfigAllow, getConfigPolicies, getConfigProxy, getDownloadDir, getOutputDir, getConfigDevMode } from "./config/loader.js";
import { startServer } from "./server.js";
import { checkForUpdates } from "./cli/updater.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import chalk from "chalk";
import boxen from "boxen";
import pc from "picocolors";
import { WEAVETAB_VERSION } from "./version.js";

// ─── Server-Process Singleton Lock ────────────────────────────────────────────
// When an IDE opens multiple windows or reconnects after a crash, it spawns a new
// `node dist/index.js` MCP process each time. Without a guard, these stack up
// silently — each eating ~50-150 MB RAM with open timers/watchers. This lock
// detects a live server process and exits the duplicate immediately.
const _SERVER_LOCK_DIR = path.join(os.homedir(), ".weavetab-system", "locks");
const _SERVER_LOCK_FILE = path.join(_SERVER_LOCK_DIR, ".weavetab-server.pid");

function _isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function _acquireServerLock(): boolean {
  try {
    fs.mkdirSync(_SERVER_LOCK_DIR, { recursive: true });
    if (fs.existsSync(_SERVER_LOCK_FILE)) {
      const existingPid = parseInt(fs.readFileSync(_SERVER_LOCK_FILE, "utf-8").trim(), 10);
      if (!isNaN(existingPid) && existingPid !== process.pid) {
        if (_isProcessAlive(existingPid)) {
          process.stderr.write(`[Weavetab] Another Weavetab MCP server is running (PID ${existingPid}). Client session active.\n`);
        } else {
          // Process is dead: reap stale PID lock
          try { fs.unlinkSync(_SERVER_LOCK_FILE); } catch { /* ignore */ }
        }
      }
    }

    // Also reap stale browser lock file if the recorded browser PID is dead
    const browserLockFile = path.join(_SERVER_LOCK_DIR, ".weavetab.lock");
    if (fs.existsSync(browserLockFile)) {
      try {
        const lockData = JSON.parse(fs.readFileSync(browserLockFile, "utf-8"));
        if (lockData.pid && !_isProcessAlive(lockData.pid)) {
          fs.unlinkSync(browserLockFile);
        }
      } catch { /* malformed lock, ignore */ }
    }

    fs.writeFileSync(_SERVER_LOCK_FILE, String(process.pid), "utf-8");
    return true;
  } catch {
    return true; // If we can't write the lock, proceed anyway (non-fatal)
  }
}

function _releaseServerLock(): void {
  try {
    if (fs.existsSync(_SERVER_LOCK_FILE)) {
      const pid = parseInt(fs.readFileSync(_SERVER_LOCK_FILE, "utf-8").trim(), 10);
      if (pid === process.pid) fs.unlinkSync(_SERVER_LOCK_FILE);
    }
  } catch { /* ignore */ }
}

// Ensure process.stdin is accessible for TTY check
const isInteractive = process.stdin.isTTY;

// ─── Safe Logging Helper ───────────────────────────────────────────────────────
// In MCP server mode, console.log corrupts the stdio protocol stream. Use
// process.stderr.write for server mode, console.log for interactive CLI mode.
function safeLog(message: string): void {
  if ((global as any).__wt_is_server) {
    process.stderr.write(message + "\n");
  } else {
    console.log(message);
  }
}

function printBootBanner(port: number): void {
  process.stderr.write("\n");
  process.stderr.write(chalk.bgHex("#3b82f6").bold("  Weavetab  ") + chalk.hex("#3b82f6")("  server  \n\n"));
  const config = getCachedConfig();
  process.stderr.write(chalk.gray(`  mode      `) + chalk.green(getConfigMode(config) || "session") + "\n");
  process.stderr.write(chalk.gray(`  cdp port  `) + chalk.cyan(port === 0 ? "dynamic (auto-assigned)" : String(port)) + "\n");
  process.stderr.write(chalk.yellow("  security: ") + "CDP port is bound to 127.0.0.1\n\n");
}

async function main(): Promise<void> {
  assertNotRoot();

  const args = process.argv.slice(2);

  // If NOT in a TTY environment (e.g. spawned by Claude Code as MCP server)
  if (!isInteractive && args.length === 0) {
    // Singleton guard — exit immediately if another MCP server is alive.
    // Prevents RAM spam from IDE reconnects / multiple IDE windows.
    if (!_acquireServerLock()) {
      process.exit(0);
    }
    // Release the PID lock on exit so the next invocation can take over.
    process.on("exit", _releaseServerLock);
    process.on("SIGINT", () => { _releaseServerLock(); process.exit(0); });
    process.on("SIGTERM", () => { _releaseServerLock(); process.exit(0); });

    const config = await loadConfig();
    (global as any).__wt_is_server = true;
    await printBootBanner(getConfigAttachPort(config));
    await startServer(config, "stdio", 3000);
    return;
  }

  // Direct Command Execution
  if (args.length > 0) {
    const cmd = args[0].toLowerCase();
    if (cmd === "--help" || cmd === "-h" || cmd === "help") {
      runHelp();
      process.exit(0);
    }
    if (cmd === "config") {
      await runConfigWizard();
      checkForUpdates().catch(() => { });
      process.exit(0);
    }
    if (cmd === "reset" || cmd === "reload") {
      const skipConfirm = args.includes("--yes") || args.includes("-y");
      await runReset(skipConfirm);
      checkForUpdates().catch(() => { });
      process.exit(0);
    }

    if (cmd === "reload-ext" || cmd === "reload-extension") {
      await reloadExtension();
      process.exit(0);
    }
    if (cmd === "view") {
      await printConfig();
      checkForUpdates().catch(() => { });
      process.exit(0);
    }
    if (cmd === "secrets") {
      await runSecretsCommand(args.slice(1));
      process.exit(0);
    }
    if (cmd === "plugin") {
      const { runPluginCli } = await import("./cli/plugin.js");
      await runPluginCli(args.slice(1));
      process.exit(0);
    }
    if (cmd === "init" || cmd === "create" || cmd === "build" || cmd === "manifest") {
      console.log(pc.yellow(`\n[Weavetab] Plugin authoring commands are part of the developer SDK (@weavetab/sdk).`));
      console.log(pc.dim("To scaffold a new plugin:   ") + pc.cyan("npx -y @weavetab/sdk init <name>"));
      console.log(pc.dim("To build/validate a plugin: ") + pc.cyan("npx @weavetab/sdk build"));
      console.log(pc.dim("SDK documentation:          ") + pc.cyan("https://github.com/weavetab/sdk\n"));
      process.exit(0);
    }
  }

  // Interactive UI Flow
  const configPath = GLOBAL_CONFIG_PATH;
  const isFirstRun = !fs.existsSync(configPath);

  if (isFirstRun) {
    // Lazy initialization for config directories on first startup
    try {
      const { getSystemDir } = await import("./config/loader.js");
      if (!fs.existsSync(GLOBAL_CONFIG_DIR)) {
        fs.mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
      }
      getSystemDir("logs");
      getSystemDir("memory");
      getSystemDir("profiles");
    } catch (err) {
      process.stderr.write("[Weavetab] Warning: Failed to lazily initialize directories " + err + "\n");
    }

    await runConfigWizard();


    await loadConfig();
    await runMainUI();
  }

  // ─── IDE Detection Utilities ─────────────────────────────────────────────────────

  interface DetectedIDE {
    name: string;
    configPath: string;
    configFormat: "claude" | "cursor" | "windsurf";
  }

  function detectIDEs(): DetectedIDE[] {
    const detected: DetectedIDE[] = [];
    const home = os.homedir();

    // Claude Desktop
    const claudeConfigPath = path.join(home, ".config", "Claude", "claude_desktop_config.json");
    if (fs.existsSync(claudeConfigPath)) {
      detected.push({ name: "Claude Desktop", configPath: claudeConfigPath, configFormat: "claude" });
    }

    // Cursor
    const cursorConfigPath = path.join(home, ".cursor", "mcp_config.json");
    if (fs.existsSync(cursorConfigPath)) {
      detected.push({ name: "Cursor", configPath: cursorConfigPath, configFormat: "cursor" });
    }

    // Windsurf
    const windsurfConfigPath = path.join(home, ".windsurf", "mcp_config.json");
    if (fs.existsSync(windsurfConfigPath)) {
      detected.push({ name: "Windsurf", configPath: windsurfConfigPath, configFormat: "windsurf" });
    }

    return detected;
  }

  function generateMCPConfigEntry(configPath: string): string {
    const entry = {
      command: "weavetab",
      args: [],
      env: {}
    };
    return JSON.stringify(entry, null, 2);
  }

  async function copyToClipboard(text: string): Promise<void> {
    try {
      const clipboardy = await import("clipboardy");
      await clipboardy.default.write(text);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
    }
  }

  // ─── Browser Detection ───────────────────────────────────────────────────────────

  function detectBrowserPath(): string {
    const platform = os.platform();

    if (platform === "win32") {
      const LOCAL = process.env.LOCALAPPDATA || "";
      const PROG = process.env.ProgramFiles || "C:\\Program Files";
      const PROG_X86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

      const candidates = [
        path.join(PROG, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(PROG_X86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(LOCAL, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(PROG_X86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(PROG, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(LOCAL, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(PROG, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(PROG_X86, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
        path.join(LOCAL, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) return p;
      }
      return "auto";
    }

    if (platform === "darwin") {
      const candidates = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) return p;
      }
      // Check home dir for user-installed Chromium
      const homeLocal = path.join(os.homedir(), "Applications");
      const userCandidates = [
        path.join(homeLocal, "Google Chrome.app/Contents/MacOS/Google Chrome"),
        path.join(homeLocal, "Chromium.app/Contents/MacOS/Chromium"),
      ];
      for (const p of userCandidates) {
        if (fs.existsSync(p)) return p;
      }
      return "auto";
    }

    // Linux
    const candidates = [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/brave-browser",
      "/usr/bin/brave-browser-stable",
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    // Snap packages
    const snapCandidates = [
      "/snap/bin/chromium",
      "/snap/bin/brave",
    ];
    for (const p of snapCandidates) {
      if (fs.existsSync(p)) return p;
    }
    return "auto";
  }

  async function runConfigWizard() {
    const p = await import("@clack/prompts");

    console.clear();
    p.intro(`${pc.bgCyan(pc.black(" Weavetab Config "))}  ${pc.cyan("Professional Configuration Wizard")}`);

    const a: Record<string, any> = {};
    type Step = () => Promise<"next" | "back">;

    const S = {
      sl: (msg: string, opts: { initialValue?: any; options: Array<{ value: any; label: string; hint?: string }> }, key: string): Step =>
        async () => { const r = await p.select({ message: msg, ...opts }); if (p.isCancel(r)) return "back"; a[key] = r; return "next"; },
      tx: (msg: string, key: string, def: string, v?: (s: string | undefined) => string | Error | undefined): Step =>
        async () => { const r = await p.text({ message: msg, defaultValue: def, placeholder: def, validate: v }); if (p.isCancel(r)) return "back"; a[key] = typeof r === "string" ? r.trim() : ""; return "next"; },
      cf: (msg: string, key: string, def: boolean): Step =>
        async () => { const r = await p.confirm({ message: msg, initialValue: def }); if (p.isCancel(r)) return "back"; a[key] = r; return "next"; },
    };

    const run = async (steps: Step[]): Promise<"next" | "back"> => {
      let i = 0;
      while (i < steps.length) {
        const act = await steps[i]();
        if (act === "next") i++;
        else if (i > 0) i--;
        else return "back";
      }
      return "next";
    };

    // ── PHASE 1: ESSENTIALS (required) ─────────────────────────────────────────
    console.log(boxen(pc.cyan("PHASE 1: ESSENTIALS"), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));
    p.note("Press Ctrl+C at any prompt to go back. Fields marked with * are required.", "ESSENTIAL CONFIGURATION");

    if ((await run([
      S.sl("Browser executable path *", {
        initialValue: "auto", options: [
          { value: "auto", label: "Auto-detect", hint: "Automatically find Chrome/Edge/Brave" },
          { value: "custom", label: "Custom path", hint: "Specify exact browser executable" }
        ]
      }, "browserChoice"),
      async (): Promise<"next" | "back"> => {
        if (a.browserChoice === "custom") {
          const raw = await p.text({ message: "Enter browser executable path *", placeholder: "/path/to/browser" });
          if (p.isCancel(raw)) return "back";
          if (typeof raw !== "string" || !raw.trim()) {
            console.log(pc.red("Path is required for custom browser."));
            return "back";
          }
          a.browser = raw.trim();
        } else {
          const detected = detectBrowserPath();
          a.browser = detected !== "auto" ? detected : "auto";
          if (detected !== "auto") {
            console.log(pc.green(`[OK] Detected: ${detected}`));
          } else {
            console.log(pc.yellow("[WARN] No browser detected, will use system default"));
          }
        }
        return "next";
      },
      S.sl("Role *", {
        initialValue: "admin", options: [
          { value: "admin", label: "Admin", hint: "Full access to all tools" },
          { value: "viewer", label: "Viewer", hint: "Read-only access (map, find, scrape, console)" },
          { value: "automation", label: "Automation", hint: "CI/CD mode (burst, plan, wait, map)" },
        ]
      }, "role"),
      S.cf("Run browser in headless mode? *", "headless", false),
      S.cf("Enable Developer Mode? *", "devMode", false),
      S.tx("Maximum pages to keep alive at once", "maxTabs", "3", val => {
        const parsed = parseInt(val ?? "", 10);
        if (isNaN(parsed) || parsed < 1) return "Must be at least 1";
        return undefined;
      }),
      S.tx("Actionability timeout (ms)", "actionabilityTimeout", "500", val => {
        const parsed = parseInt(val ?? "", 10);
        if (isNaN(parsed) || parsed < 10) return "Must be at least 10";
        return undefined;
      }),
      S.tx("Domains to block (optional, comma-separated)", "blockRaw", ""),
      S.tx("Domains to allow (optional, comma-separated)", "allowRaw", ""),
    ])) === "back") process.exit(0);

    // Process block/allow lists
    a.block = typeof a.blockRaw === "string" && a.blockRaw.trim() ? a.blockRaw.split(",").map((d: string) => d.trim()).filter(Boolean) : [];
    a.allow = typeof a.allowRaw === "string" && a.allowRaw.trim() ? a.allowRaw.split(",").map((d: string) => d.trim()).filter(Boolean) : [];
    delete a.blockRaw; delete a.allowRaw; delete a.browserChoice;

    // ── PHASE 2: ADVANCED TREE (optional) ───────────────────────────────────────
    console.log(boxen(pc.yellow("PHASE 2: ADVANCED"), { padding: 1, borderStyle: 'round', borderColor: 'yellow' }));
    p.note(pc.yellow("[NOTE] Most users can skip this. Press Enter to skip advanced configuration."), "OPTIONAL");

    const configureAdvanced = await p.confirm({
      message: "Configure advanced settings?",
      initialValue: false
    });

    if (p.isCancel(configureAdvanced)) {
      a.advanced = false;
    } else {
      a.advanced = configureAdvanced;
    }

    if (a.advanced) {
      // Advanced section picker
      const sectionChoice = await p.select({
        message: "Select advanced section to configure:",
        options: [
          { value: "A", label: "A — Browser Engine & Flags", hint: "Engine type, extensions, flags, profile, cookies" },
          { value: "B", label: "B — Timeouts & Limits", hint: "Session, navigation, idle timeouts, rate limits" },
          { value: "C", label: "C — Developer & Theming", hint: "Dark mode, telemetry, GitHub cache" },
          { value: "D", label: "D — Storage & Proxy", hint: "Download directory, proxy settings" },
          { value: "E", label: "E — Policies", hint: "Raw JSON policy entries" },
          { value: "skip", label: "Skip advanced", hint: "Use defaults for all advanced settings" },
        ]
      });

      if (p.isCancel(sectionChoice) || sectionChoice === "skip") {
        a.advanced = false;
      } else {
        // Section A: Browser Engine & Flags
        if (sectionChoice === "A") {
          console.log(boxen(pc.cyan("SECTION A: BROWSER ENGINE & FLAGS"), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));
          if ((await run([
            S.sl("Browser engine", {
              initialValue: "chromium", options: [
                { value: "chromium", label: "Chromium", hint: "Chrome, Edge, Brave" },
                { value: "firefox", label: "Firefox", hint: "Experimental" },
                { value: "webkit", label: "WebKit", hint: "Experimental" },
              ]
            }, "browserType"),
            S.cf("Enable Weavetab browser extension?", "extension", true),
            S.cf("Persist cookies across sessions?", "cookies", false),
            S.tx("Extra browser flags (space-separated)", "browserFlagsRaw", ""),
            S.tx("Custom browser profile directory", "profileDir", ""),
          ])) === "back") process.exit(0);
          a.browserFlags = typeof a.browserFlagsRaw === "string" && a.browserFlagsRaw.trim() ? a.browserFlagsRaw.split(/\s+/).filter(Boolean) : [];
          delete a.browserFlagsRaw;
        }

        // Section B: Timeouts & Limits
        if (sectionChoice === "B") {
          console.log(boxen(pc.cyan("SECTION B: TIMEOUTS & LIMITS"), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));
          if ((await run([
            S.tx("Session timeout (seconds)", "sessionTimeout", "3600", (v) => { const n = parseInt(v ?? ""); if (isNaN(n) || n < 60) return "Min 60 seconds."; }),
            S.tx("Navigation timeout (ms)", "navigationTimeout", "30000", (v) => { const n = parseInt(v ?? ""); if (isNaN(n) || n < 1000 || n > 120000) return "1000-120000 ms."; }),
            S.tx("Idle timeout (ms)", "idleTimeout", "60000", (v) => { const n = parseInt(v ?? ""); if (isNaN(n) || n < 5000) return "Min 5000 ms."; }),
            S.tx("Max actions per minute", "maxActionsPerMinute", "60", (v) => { const n = parseInt(v ?? ""); if (isNaN(n) || n < 1) return "Positive integer."; }),
            S.tx("Actionability timeout (ms)", "actionabilityTimeout", "500", (v) => { const n = parseInt(v ?? ""); if (isNaN(n) || n < 100) return "Min 100 ms."; }),
          ])) === "back") process.exit(0);
        }

        // Section C: Developer & Telemetry
        if (sectionChoice === "C") {
          console.log(boxen(pc.cyan("SECTION C: DEVELOPER & TELEMETRY"), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));
          if ((await run([
            S.cf("Send anonymous telemetry?", "telemetry", false),
            S.tx("GitHub cache TTL (ms)", "githubCacheTtlMs", "1800000", (v) => { const n = parseInt(v ?? ""); if (isNaN(n) || n < 0) return "Positive integer."; }),
          ])) === "back") process.exit(0);
        }

        // Section D: Storage & Proxy
        if (sectionChoice === "D") {
          console.log(boxen(pc.cyan("SECTION D: STORAGE & PROXY"), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));
          if ((await run([
            S.tx("Download directory", "downloadDir", ""),
            S.tx("Proxy URL (or $WT_PROXY_URL)", "proxy", ""),
          ])) === "back") process.exit(0);
        }

        // Section E: Policies
        if (sectionChoice === "E") {
          console.log(boxen(pc.cyan("SECTION E: POLICIES"), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));
          const policiesRaw = await p.text({
            message: "Policy entries (JSON array)",
            placeholder: '[{"pattern": "*.bank.*", "mode": "deny"}]',
            defaultValue: "[]"
          });
          if (p.isCancel(policiesRaw)) process.exit(0);
          try {
            a.policies = JSON.parse(policiesRaw as string);
          } catch {
            console.log(pc.red("Invalid JSON, using empty policies."));
            a.policies = [];
          }
        }
      }
    }

    // ── PHASE 3: SAVE LOCATION (final step) ───────────────────────────────────────
    console.log(boxen(pc.green("PHASE 3: SAVE LOCATION"), { padding: 1, borderStyle: 'round', borderColor: 'green' }));
    console.log(pc.cyan(`Configuration will be saved globally to: ${GLOBAL_CONFIG_DIR}`));
    a.saveLocation = "global";

    // ── WRITE CONFIG ─────────────────────────────────────────────────────────────
    const s = p.spinner();
    s.start("Writing configuration…");

    try {
      const partialConfig: Record<string, any> = {
        mode: "session",
        browserPath: a.browser,
        role: a.role,
        headless: a.headless,
        devMode: a.devMode,
        maxTabs: parseInt(a.maxTabs as string),
        block: a.block,
        allow: a.allow,
      };

      if (a.advanced) {
        Object.assign(partialConfig, {
          browserType: a.browserType || "chromium",
          extension: a.extension !== undefined ? a.extension : true,
          cookies: a.cookies || false,
          browserFlags: a.browserFlags || [],
          profileDir: a.profileDir || "",
          sessionTimeout: parseInt(a.sessionTimeout as string) || 3600,
          navigationTimeout: parseInt(a.navigationTimeout as string) || 30000,
          idleTimeout: parseInt(a.idleTimeout as string) || 60000,
          maxActionsPerMinute: parseInt(a.maxActionsPerMinute as string) || 60,
          actionabilityTimeout: parseInt(a.actionabilityTimeout as string) || 500,
          telemetry: a.telemetry || false,
          githubCacheTtlMs: parseInt(a.githubCacheTtlMs as string) || 1800000,
          downloadDir: a.downloadDir || "",
          proxy: typeof a.proxy === "string" && a.proxy.trim() ? a.proxy.trim() : undefined,
          policies: a.policies || [],
        });
      }

      const configDir = GLOBAL_CONFIG_DIR;
      if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
      const configFilePath = path.join(configDir, "config.json");
      const existing = fs.existsSync(configFilePath)
        ? JSON.parse(fs.readFileSync(configFilePath, "utf-8"))
        : {};
      saveConfig({ ...existing, ...partialConfig });
      await loadConfig();

      s.stop(pc.green("[OK] Configuration saved"));

      // ── PHASE 4: MCP CONFIG INTEGRATION ─────────────────────────────────────────
      console.log(boxen(pc.magenta("PHASE 4: MCP CONFIGURATION"), { padding: 1, borderStyle: 'round', borderColor: 'magenta' }));

      const detectedIDEs = detectIDEs();
      let mcpConfigured = false;

      if (detectedIDEs.length > 0) {
        const ideNames = detectedIDEs.map(ide => ide.name).join(", ");
        const configureMCP = await p.confirm({
          message: `Detected ${ideNames}. Add Weavetab to MCP config?`,
          initialValue: true
        });

        if (!p.isCancel(configureMCP) && configureMCP) {
          const targetIDE = detectedIDEs.length === 1 ? detectedIDEs[0] :
            (await p.select({
              message: "Select IDE to configure:",
              options: detectedIDEs.map(ide => ({ value: ide.name, label: ide.name, hint: ide.configPath }))
            }));

          if (!p.isCancel(targetIDE)) {
            const ide = detectedIDEs.find(i => i.name === targetIDE);
            if (ide) {
              const action = await p.select({
                message: "How would you like to add the config?",
                options: [
                  { value: "merge", label: "Merge (safe)", hint: "Backup existing, merge, and confirm" },
                  { value: "copy", label: "Copy to clipboard", hint: "Copy config snippet, paste manually" },
                  { value: "skip", label: "Skip", hint: "Configure manually later" },
                ]
              });

              if (!p.isCancel(action) && action !== "skip") {
                if (action === "merge") {
                  // Safe merge with backup
                  try {
                    const backupPath = `${ide.configPath}.backup`;
                    fs.copyFileSync(ide.configPath, backupPath);

                    let existingConfig: any = {};
                    try {
                      existingConfig = JSON.parse(fs.readFileSync(ide.configPath, "utf-8"));
                    } catch {
                      existingConfig = { mcpServers: {} };
                    }

                    if (!existingConfig.mcpServers) existingConfig.mcpServers = {};
                    existingConfig.mcpServers.weavetab = {
                      command: "weavetab",
                      args: []
                    };

                    fs.writeFileSync(ide.configPath, JSON.stringify(existingConfig, null, 2));
                    console.log(pc.green(`[OK] Merged config to ${ide.configPath}`));
                    console.log(pc.dim(`  Backup saved to ${backupPath}`));
                    mcpConfigured = true;
                  } catch (err) {
                    console.log(pc.red(`[ERROR] Failed to merge config: ${err}`));
                  }
                } else if (action === "copy") {
                  const configSnippet = JSON.stringify({
                    mcpServers: {
                      weavetab: {
                        command: "weavetab",
                        args: []
                      }
                    }
                  }, null, 2);
                  await copyToClipboard(configSnippet);
                  console.log(pc.green("[OK] Config copied to clipboard"));
                  console.log(pc.dim(`  Paste this into ${ide.configPath}`));
                  mcpConfigured = true;
                }
              }
            }
          }
        }
      } else {
        const manualConfig = await p.confirm({
          message: "No IDE detected. Generate MCP config for manual setup?",
          initialValue: false
        });

        if (!p.isCancel(manualConfig) && manualConfig) {
          const configSnippet = JSON.stringify({
            mcpServers: {
              weavetab: {
                command: "weavetab",
                args: []
              }
            }
          }, null, 2);
          await copyToClipboard(configSnippet);
          console.log(pc.green("[OK] Config copied to clipboard"));
          console.log(pc.dim("  Add this to your IDE's MCP config file"));
          mcpConfigured = true;
        }
      }

      // ── PHASE 5: SUMMARY ───────────────────────────────────────────────────────
      console.log(boxen(pc.green("CONFIGURATION COMPLETE"), { padding: 1, borderStyle: 'round', borderColor: 'green' }));

      const summary: string[] = [
        `${pc.dim("Browser:")}        ${a.browser}`,
        `${pc.dim("Role:")}           ${a.role}`,
        `${pc.dim("Headless:")}       ${a.headless ? "yes" : "no"}`,
        `${pc.dim("Dev Mode:")}       ${a.devMode ? "yes" : "no"}`,
        `${pc.dim("Max tabs:")}       ${partialConfig.maxTabs}`,
        `${pc.dim("Config location:")} ~/.weavetab/config.json`,
        `${pc.dim("MCP Config:")}     ${mcpConfigured ? pc.green("[OK] Configured") : pc.yellow("Pending")}`,
      ];

      if (a.block?.length) summary.push(`${pc.dim("Blocked:")}   ${a.block.join(", ")}`);
      if (a.allow?.length) summary.push(`${pc.dim("Allowed:")}   ${a.allow.join(", ")}`);

      p.note(summary.join("\n"), "SUMMARY");

      if (!mcpConfigured) {
        console.log(pc.dim("\nTo configure MCP manually, run: weavetab config-mcp"));
      }

      p.outro(`${pc.green("Weavetab is ready!")}  ${pc.dim("Run")} ${pc.cyan("weavetab help")} ${pc.dim("to see available commands.")}`);
    } catch (err) {
      s.stop(pc.red("Failed to save configuration."));
      throw err;
    }
  }

  async function runReset(skipConfirm = false) {
    const ora = (await import("ora")).default;
    const { execSync, spawnSync } = await import("node:child_process");

    if (!skipConfirm) {
      console.clear();
      console.log(boxen(pc.yellow("SYSTEM RESET"), { padding: 1, borderStyle: 'round', borderColor: 'yellow' }));

      console.log(pc.yellow("[WARNING] This will:"));
      console.log("  - Terminate all Weavetab browser processes");
      console.log("  - Clear all lockfiles and mutexes");
      console.log("  - Purge session registry");
      console.log("  - Reset system state");
      console.log();

      const p = await import("@clack/prompts");
      const confirm = await p.confirm({
        message: "Proceed with system reset?",
        initialValue: false
      });

      if (p.isCancel(confirm) || !confirm) {
        console.log(pc.dim("Reset cancelled."));
        process.exit(0);
      }
    }

    const spinner = ora("Purging profiles and clearing lockfiles...").start();

    try {
      const lockDir = path.join(os.homedir(), ".weavetab-system", "locks");
      const lockFile = path.join(lockDir, ".weavetab.lock");

      // Step 1: Kill process from lock file
      if (fs.existsSync(lockFile)) {
        try {
          const lockData = JSON.parse(fs.readFileSync(lockFile, "utf-8"));
          if (lockData.pid) {
            try {
              process.kill(lockData.pid);
              spinner.text = "Terminating locked process...";
            } catch {
              // Process may already be dead
            }
          }
        } catch { /* ignore */ }
      }

      const mutexFile = path.join(lockDir, ".weavetab.lock.mutex");
      if (fs.existsSync(mutexFile)) {
        try {
          const mutexPid = parseInt(fs.readFileSync(mutexFile, "utf-8").trim(), 10);
          if (!isNaN(mutexPid)) {
            try {
              process.kill(mutexPid, 9);
              spinner.text = "Terminating Node process holding mutex...";
            } catch { /* ignore */ }
          }
        } catch { /* ignore */ }
      }

      // Step 2: Clear system lockfiles
      spinner.text = "Clearing system lockfiles...";
      if (fs.existsSync(lockDir)) {
        const files = fs.readdirSync(lockDir);
        for (const file of files) {
          if (file.endsWith(".lock") || file.endsWith(".mutex")) {
            try {
              const p = path.join(lockDir, file);
              if (fs.statSync(p).isDirectory()) {
                fs.rmSync(p, { recursive: true, force: true });
              } else {
                fs.unlinkSync(p);
              }
            } catch { /* ignore */ }
          }
        }
      }

      // Step 3: Clear registry
      spinner.text = "Clearing session registry...";
      const registryDir = path.join(os.homedir(), ".weavetab-system", "registry");
      const registryFile = path.join(registryDir, "contexts.json");
      if (fs.existsSync(registryFile)) {
        try { fs.unlinkSync(registryFile); } catch { /* ignore */ }
      }

      // Step 4: Kill orphan browser processes
      spinner.text = "Terminating orphan browser processes...";
      const defaultProfilePath = path.join(os.homedir(), ".weavetab-system", "session-profile");
      let profilePath = defaultProfilePath;
      try {
        if (fs.existsSync(lockFile)) {
          const lockData = JSON.parse(fs.readFileSync(lockFile, "utf-8"));
          if (lockData.profileDir && typeof lockData.profileDir === "string" && lockData.profileDir.trim()) {
            profilePath = lockData.profileDir;
          }
        }
      } catch { /* use default */ }

      // Never interpolate profilePath into a shell command string.
      // Windows: parse tasklist output in JS, kill each matching PID with taskkill args array.
      // Unix: parse ps output in JS, kill each matching PID with process.kill().
      try {
        const normalizedProfilePath = path.resolve(profilePath).toLowerCase();
        if (os.platform() === 'win32') {
          // tasklist /FO CSV /NH — no user data in the command string at all
          const result = execSync('tasklist /FO CSV /NH /V', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
          const lines = result.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // CSV fields: "Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"
            const fields = trimmed.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(f => f.replace(/^"|"$/g, ''));
            const imageName = (fields[0] ?? '').toLowerCase();
            const pid = parseInt(fields[1] ?? '0', 10);
            const windowTitle = (fields[8] ?? '').toLowerCase();
            // Filter by browser process name and profile path in window title or command line
            const isBrowser = imageName === 'chrome.exe' || imageName === 'msedge.exe' || imageName === 'brave.exe';
            if (isBrowser && pid > 0 && windowTitle.includes(normalizedProfilePath)) {
              spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
            }
          }
          // Also try with wmic-free approach via PowerShell if available, matching by profile in commandline
          try {
            // Pass the profile path as a PowerShell variable via -Command with a
            // param block so it is never evaluated as code. This avoids escaping
            // pitfalls where metacharacters like $(), backtick, |, ; in a tampered
            // lock file could be executed.
            const psCommand = [
              'param([string]$ProfilePath)',
              'Get-WmiObject Win32_Process',
              '| Where-Object { $_.CommandLine -like ("*" + $ProfilePath + "*") -and ($_.Name -eq "chrome.exe" -or $_.Name -eq "msedge.exe" -or $_.Name -eq "brave.exe") }',
              '| Select-Object -ExpandProperty ProcessId',
            ].join(' ');
            const psResult = spawnSync('powershell', [
              '-NoProfile', '-NonInteractive', '-Command',
              `& { ${psCommand} }`, normalizedProfilePath,
            ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            if (psResult.status === 0 && psResult.stdout) {
              for (const pidLine of psResult.stdout.split('\n')) {
                const pid = parseInt(pidLine.trim(), 10);
                if (pid > 0) {
                  spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
                }
              }
            }
          } catch { /* PowerShell not available, tasklist approach above is sufficient */ }
        } else {
          // Unix: read ps output in JS, filter in JS, kill with process.kill — never interpolate into shell
          const psResult = execSync('ps -ax -o pid= -o command=', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
          for (const line of psResult.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const spaceIdx = trimmed.indexOf(' ');
            if (spaceIdx === -1) continue;
            const pid = parseInt(trimmed.slice(0, spaceIdx), 10);
            const cmd = trimmed.slice(spaceIdx + 1);
            if (!isNaN(pid) && pid > 0 && cmd.toLowerCase().includes(normalizedProfilePath)) {
              try { process.kill(pid, 'SIGKILL'); } catch { /* process already gone */ }
            }
          }
        }
      } catch { /* ignore */ }

      spinner.succeed(chalk.green("[OK] System reset complete"));

      console.log();
      console.log(pc.dim("Cleared:"));
      console.log("  - Lockfiles and mutexes");
      console.log("  - Session registry");
      console.log("  - Orphan browser processes");
      console.log();

      // Invalidate config cache so next launch re-reads from disk
      const { invalidateConfigCache } = await import("./config/loader.js");
      invalidateConfigCache();

      console.log(pc.green("[OK] Config cache invalidated"));
      console.log(pc.dim("Next launch will re-read configuration from disk"));

    } catch (e) {
      spinner.fail(chalk.red(`[ERROR] Reset failed: ${e}`));
      process.exit(1);
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  async function reloadExtension() {
    const ora = (await import("ora")).default;
    const CDP = (await import("chrome-remote-interface")).default;

    console.log(boxen(pc.cyan("EXTENSION RELOAD"), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));

    const lockDir = path.join(os.homedir(), ".weavetab-system", "locks");
    const lockFile = path.join(lockDir, ".weavetab.lock");

    if (!fs.existsSync(lockFile)) {
      console.log(pc.red("[ERROR] No running Weavetab browser instance found."));
      console.log(pc.dim("Start Weavetab first to reload the extension."));
      process.exit(1);
    }

    let lockData: any;
    try {
      lockData = JSON.parse(fs.readFileSync(lockFile, "utf-8"));
    } catch {
      console.log(pc.red("[ERROR] Failed to read lock file."));
      process.exit(1);
    }

    const spinner = ora("Connecting to browser...").start();
    try {
      const browser = await CDP({ host: "127.0.0.1", port: lockData.port });
      const { Target } = browser;

      const { targetInfos } = await Target.getTargets();
      const page = targetInfos.find((t: any) => t.type === "page");
      if (!page) {
        spinner.fail(pc.red("[ERROR] No available tab to send reload signal."));
        await browser.close();
        process.exit(1);
      }

      await browser.close();
      const client = await CDP({ host: "127.0.0.1", port: lockData.port, target: page.targetId });
      const { Runtime } = client;
      await Runtime.evaluate({
        expression: `try { window.dispatchEvent(new CustomEvent('Weavetab-msg-in', { detail: { type: 'Weavetab_RELOAD_EXTENSION' } })); } catch(e) {}`,
      });
      await client.close();
      spinner.succeed(pc.green("[OK] Extension reload signal sent. Extension will reload momentarily."));
    } catch (e: any) {
      spinner.fail(pc.red(`[ERROR] Failed to reload extension: ${e?.message || e}`));
      process.exit(1);
    }
    process.exit(0);
  }

  async function printConfig() {
    const config = await loadConfig();
    const globalConfigPath = GLOBAL_CONFIG_PATH;
    const hasGlobal = fs.existsSync(globalConfigPath);

    console.clear();

    // Config resolution info
    console.log(boxen(pc.cyan("CONFIG RESOLUTION"), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));

    const resolution: string[] = [];
    if (hasGlobal) {
      resolution.push(pc.green("[ACTIVE] Global config: ") + pc.dim(globalConfigPath));
    } else {
      resolution.push(pc.yellow("[WARNING] No config found - using built-in defaults"));
      resolution.push(pc.dim("Run 'weavetab config' to create a configuration"));
    }

    console.log(resolution.join("\n"));
    console.log();

    // Active config display
    console.log(boxen(pc.cyan("ACTIVE CONFIGURATION"), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));

    const configLines: string[] = [
      `${pc.dim("Mode:")}              ${getConfigMode(config)}`,
      `${pc.dim("Browser:")}           ${getConfigBrowserPath(config)}`,
      `${pc.dim("Browser Type:")}     ${getConfigBrowserType(config)}`,
      `${pc.dim("Role:")}              ${getConfigRole(config)}`,
      `${pc.dim("Headless:")}          ${getConfigHeadless(config) ? "yes" : "no"}`,
      `${pc.dim("Dev Mode:")}          ${typeof getConfigDevMode(config) === "boolean" ? (getConfigDevMode(config) ? "yes" : "no") : "advanced"}`,
      `${pc.dim("Extension:")}         ${getConfigExtension(config) ? "yes" : "no"}`,
      `${pc.dim("Max Tabs:")}          ${getConfigMaxTabs(config)}`,
      `${pc.dim("Session Timeout:")}   ${getConfigSessionTimeout(config)}s`,
      `${pc.dim("Navigation Timeout:")} ${getConfigNavigationTimeout(config)}ms`,
      `${pc.dim("Idle Timeout:")}      ${getConfigIdleTimeout(config)}ms`,
      `${pc.dim("Max Actions/Min:")}   ${getConfigMaxActionsPerMinute(config)}`,
      `${pc.dim("Telemetry:")}         ${getConfigTelemetry(config) ? "yes" : "no"}`,
    ];

    const electronApps = getElectronApps(config);
    const appNames = Object.keys(electronApps);
    if (appNames.length > 0) {
      configLines.push(`${pc.dim("Electron Apps:")}    ${appNames.join(", ")}`);
    }

    const blockList = getConfigBlock(config);
    if (blockList?.length) {
      configLines.push(`${pc.dim("Blocked Domains:")}   ${blockList.join(", ")}`);
    }
    const allowList = getConfigAllow(config);
    if (allowList?.length) {
      configLines.push(`${pc.dim("Allowed Domains:")}   ${allowList.join(", ")}`);
    }
    const policies = getConfigPolicies(config);
    if (policies?.length) {
      configLines.push(`${pc.dim("Policies:")}          ${policies.length} entries`);
    }
    const proxy = getConfigProxy(config);
    if (proxy) {
      configLines.push(`${pc.dim("Proxy:")}             ${proxy}`);
    }
    const downloadDir = getDownloadDir(config);
    if (downloadDir) {
      configLines.push(`${pc.dim("Download Dir:")}      ${downloadDir}`);
    }
    configLines.push(`${pc.dim("PDF Dir:")}            ${getOutputDir("pdfs", config)}`);
    configLines.push(`${pc.dim("Snapshot Dir:")}       ${getOutputDir("snapshots", config)}`);
    configLines.push(`${pc.dim("Recording Dir:")}      ${getOutputDir("recordings", config)}`);

    console.log(configLines.join("\n"));
    console.log();

    // Raw config option
    console.log(pc.dim("Press [R] to view raw JSON, [Q] to quit"));

    await new Promise<void>((resolve) => {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");

      const onKey = (key: string) => {
        if (key.toLowerCase() === "q" || key === "\u0003") {
          process.stdin.removeListener("data", onKey);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          resolve();
        } else if (key.toLowerCase() === "r") {
          process.stdin.removeListener("data", onKey);
          process.stdin.setRawMode(false);
          process.stdin.pause();

          console.clear();
          console.log(boxen(pc.cyan("RAW CONFIGURATION JSON"), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));
          console.log(JSON.stringify(config, null, 2));
          console.log(pc.dim("\nPress any key to return..."));

          process.stdin.once("data", () => {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            resolve();
          });
        }
      };

      process.stdin.on("data", onKey);
    });
  }

  async function runMainUI() {
    const open = (await import("open")).default;
    const config = await loadConfig();
    const _require = createRequire(import.meta.url);
    const version = _require("../package.json").version || WEAVETAB_VERSION;

    console.clear();
    await checkForUpdates();

    // Config resolution info
    const globalConfigPath = GLOBAL_CONFIG_PATH;
    const hasGlobal = fs.existsSync(globalConfigPath);

    let configStatus = "";
    if (hasGlobal) {
      configStatus = pc.dim("[GLOBAL] ") + pc.green("Global config active");
    } else {
      configStatus = pc.yellow("[DEFAULTS] ") + pc.dim("Using built-in defaults");
    }

    console.log(boxen(pc.cyan(`Weavetab Server v${version}`), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));

    console.log(pc.dim("Production-grade MCP server for Chrome DevTools Protocol"));
    console.log();
    console.log(pc.dim("Config: ") + configStatus);
    console.log(pc.dim("Role: ") + pc.cyan(getConfigRole(config)));
    console.log(pc.dim("Mode: ") + pc.cyan(getConfigMode(config)));
    console.log();

    console.log(pc.bold("COMMANDS"));
    console.log(`  ${pc.cyan("[C]")}  Config    Launch the configuration wizard`);
    console.log(`  ${pc.cyan("[V]")}  View      View current active configuration`);
    console.log(`  ${pc.cyan("[P]")}  Plugins   List installed Weavetab plugins`);
    console.log(`  ${pc.cyan("[R]")}  Reset     Purge browser profiles and lockfiles`);
    console.log(`  ${pc.cyan("[H]")}  Help      Show help information`);
    console.log(`  ${pc.cyan("[Q]")}  Quit      Exit Weavetab`);
    console.log();

    console.log(pc.bold("LINKS"));
    console.log(`  ${pc.cyan("[G]")}  GitHub    ${pc.dim("github.com/Weavetab")}`);
    console.log(`  ${pc.cyan("[N]")}  NPM       ${pc.dim("npmjs.com/package/Weavetab")}`);
    console.log(`  ${pc.cyan("[W]")}  Website   ${pc.dim("weavetab.dev")}`);
    console.log();

    console.log(pc.dim("Awaiting command..."));

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onKey = async (key: string) => {
      const k = key.toLowerCase();
      if (k === "q" || key === "\u0003") {
        process.stdin.removeListener("data", onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        console.log(pc.dim("\n[SHUTDOWN] Exiting Weavetab\n"));
        process.exit(0);
      }
      if (k === "c") {
        process.stdin.removeListener("data", onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        await runConfigWizard();
        runMainUI();
      }
      if (k === "p") {
        process.stdin.removeListener("data", onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        const { runPluginList } = await import("./cli/plugin.js");
        await runPluginList();
        console.log(pc.dim("Press any key to return..."));
        await new Promise<void>((resolve) => {
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.once("data", () => {
            process.stdin.setRawMode(false);
            process.stdin.pause();
            resolve();
          });
        });
        runMainUI();
      }
      if (k === "r") {
        process.stdin.removeListener("data", onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        await runReset();
        runMainUI();
      }
      if (k === "v") {
        process.stdin.removeListener("data", onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        await printConfig();
        runMainUI();
      }
      if (k === "h") {
        process.stdin.removeListener("data", onKey);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        await runHelp();
        runMainUI();
      }
      if (k === "g") {
        await open("https://github.com/weavetab");
      }
      if (k === "n") {
        await open("https://www.npmjs.com/package/@weavetab/mcp");
      }
      if (k === "w") {
        await open("https://github.com/weavetab/mcp");
      }
    };

    process.stdin.on("data", onKey);
  }

  function runHelp(): void {
    const _require = createRequire(import.meta.url);
    const version = _require("../package.json").version || WEAVETAB_VERSION;

    console.clear();

    console.log(boxen(pc.cyan(`Weavetab v${version}`), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));

    console.log(pc.dim("Production-grade MCP server for Chrome DevTools Protocol"));
    console.log();

    console.log(pc.bold("USAGE"));
    console.log(`  ${pc.cyan("weavetab <command> [options]")}`);
    console.log();

    console.log(pc.bold("COMMANDS"));
    console.log(`  ${pc.cyan("plugin")}        Manage Weavetab plugins (add, list, remove, search, browse, verify)`);
    console.log(`  ${pc.cyan("config")}        Launch the interactive configuration wizard`);
    console.log(`  ${pc.cyan("view")}          Display the current active configuration`);
    console.log(`  ${pc.cyan("reset")}         Purge browser profiles, lockfiles, and orphan processes`);
    console.log(`  ${pc.cyan("secrets")}       Manage blind-injected credentials (set, list, rm)`);
    console.log(`  ${pc.cyan("reload-ext")}    Send a reload signal to the browser extension`);
    console.log(`  ${pc.cyan("help")}          Show this help message`);
    console.log();

    console.log(pc.bold("PLUGIN COMMANDS (User)"));
    console.log(`  ${pc.cyan("weavetab plugin add <pkg>")}         Install a plugin (resolves official @weavetab/plugin- & community)`);
    console.log(`  ${pc.cyan("weavetab plugin browse")}            Interactive terminal explorer to browse & 1-click install`);
    console.log(`  ${pc.cyan("weavetab plugin search <query>")}    Search plugins across registry & npm`);
    console.log(`  ${pc.cyan("weavetab plugin list")}              List all installed Weavetab plugins and tools`);
    console.log(`  ${pc.cyan("weavetab plugin remove <pkg>")}      Uninstall a plugin`);
    console.log(`  ${pc.cyan("weavetab plugin verify <pkg>")}      Check trust tier against Weavetab registry`);
    console.log();

    console.log(pc.bold("PLUGIN DEVELOPER SDK (@weavetab/sdk)"));
    console.log(`  ${pc.dim("Scaffold a plugin:")}  ${pc.cyan("npx -y @weavetab/sdk init <name>")}`);
    console.log(`  ${pc.dim("Build & validate:")}   ${pc.cyan("npx @weavetab/sdk build")}`);
    console.log();

    console.log(pc.bold("SECRETS SUBCOMMANDS"));
    console.log(`  ${pc.cyan("weavetab secrets set <key>")}        Store a new encrypted secret`);
    console.log(`  ${pc.cyan("weavetab secrets list")}             List all stored secrets`);
    console.log(`  ${pc.cyan("weavetab secrets rm <key>")}         Remove a secret by key`);
    console.log(`  ${pc.cyan("weavetab secrets init --project")}   Initialize project-scoped secrets`);
    console.log();

    console.log(pc.bold("ENVIRONMENT VARIABLES"));
    console.log(`  ${pc.cyan("WT_PROXY_URL")}      Proxy URL (overrides config value)`);
    console.log(`  ${pc.cyan("WT_AGENT_ID")}       Agent identifier (auto-generated if unset)`);
    console.log();

    console.log(pc.bold("LINKS"));
    console.log(`  ${pc.cyan("GitHub:")}  ${pc.dim("https://github.com/weavetab")}`);
    console.log(`  ${pc.cyan("npm:")}     ${pc.dim("https://www.npmjs.com/package/@weavetab/mcp")}`);
    console.log(`  ${pc.cyan("Website:")} ${pc.dim("https://github.com/weavetab/mcp")}`);
    console.log();
  }
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[Weavetab] Fatal: ${message}\n`);
    if (!process.stdin.isTTY) process.exit(1);
  });

  async function shutdown() {
    if (!(global as any).__wt_is_server) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.exit(0);
    }
    process.stderr.write("\n[Weavetab] graceful shutdown. detaching sessions...\n");
    try {
      const { sessionRegistry } = await import("./state/session.js");
      const clients = sessionRegistry.getAll();
      await Promise.all(clients.map(c => c.session.close().catch(() => { })));
      process.stderr.write("[Weavetab] sessions detached.\n");
    } catch { }
    process.exit(0);
  }

  // Only register index.ts signal handlers when NOT running as MCP server.
  // Both index.ts and server.ts would otherwise register SIGINT/SIGTERM handlers
  // in the same process, and since the last-registered handler wins, index.ts's
  // shutdown() would race server.ts's cleanup(). In server mode, server.ts is the
  // sole owner of signal handling.
  if (!(global as any).__wt_is_server) {
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }


  async function runSecretsCommand(args: string[]) {
    const { secretStore } = await import("./security/secrets.js");
    const p = await import("@clack/prompts");

    if (args.length === 0) {
      console.log(pc.red("[ERROR] Usage: weavetab secrets <set|list|rm> [key]"));
      process.exit(1);
    }

    const subcmd = args[0].toLowerCase();

    if (subcmd === "list") {
      const list = await secretStore.listSecrets();
      console.log(boxen(pc.cyan("STORED SECRETS"), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));

      if (list.length === 0) {
        console.log(pc.dim("No secrets found."));
        return;
      }

      console.log(pc.dim(`Location: ${secretStore.getSecretsFilePath()}`));
      console.log();

      for (const entry of list) {
        console.log(pc.green(`[KEY] ${entry.key}`));
        console.log(pc.dim(`  Domains: ${entry.domains.length === 0 ? "ANY (Wildcard)" : entry.domains.join(", ")}`));
        console.log(pc.dim(`  Updated: ${entry.updatedAt}`));
        console.log();
      }
      return;
    }

    if (subcmd === "rm") {
      const key = args[1];
      if (!key) {
        console.log(pc.red("[ERROR] Usage: weavetab secrets rm <key>"));
        process.exit(1);
      }
      const removed = await secretStore.removeSecret(key);
      if (removed) {
        console.log(pc.green(`[OK] Secret "${key}" removed.`));
      } else {
        console.log(pc.red(`[ERROR] Secret "${key}" not found.`));
      }
      return;
    }

    if (subcmd === "set") {
      const key = args[1];
      if (!key) {
        console.log(pc.red("[ERROR] Usage: weavetab secrets set <key>"));
        process.exit(1);
      }

      console.clear();
      console.log(boxen(pc.cyan(`SET SECRET: ${key}`), { padding: 1, borderStyle: 'round', borderColor: 'cyan' }));
      console.log(pc.dim(`Target: ${secretStore.getSecretsFilePath()}`));
      console.log();

      const value = await p.password({
        message: `Enter value for ${key}`,
        validate: (v) => (!v ? "Value cannot be empty" : undefined)
      });
      if (p.isCancel(value)) { p.cancel("Cancelled."); process.exit(0); }

      const domainsRaw = await p.text({
        message: "Allowed domains (comma-separated, e.g. 'github.com, gitlab.com')",
        placeholder: "leave empty for ANY domain (not recommended)",
        defaultValue: ""
      });
      if (p.isCancel(domainsRaw)) { p.cancel("Cancelled."); process.exit(0); }

      const domains = (typeof domainsRaw === "string" ? domainsRaw : "")
        .split(",")
        .map(d => d.trim())
        .filter(Boolean);

      if (domains.length === 0) {
        const confirm = await p.confirm({
          message: pc.yellow("[WARNING] Empty domain list allows this secret to be used on ANY website. Are you sure?"),
          initialValue: false
        });
        if (p.isCancel(confirm) || !confirm) { p.cancel("Cancelled."); process.exit(0); }
      }

      await secretStore.setSecret(key, value as string, domains);
      console.log(pc.green(`[OK] Secret "${key}" saved.`));
      return;
    }

    console.log(pc.red(`[ERROR] Unknown secrets command: ${subcmd}`));
    console.log(pc.red("Usage: weavetab secrets <set|list|rm> [key]"));
    process.exit(1);
  }
