import * as p from "@clack/prompts";
import pc from "picocolors";
import boxen from "boxen";
import ora from "ora";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

import { WEAVETAB_VERSION } from "../version.js";

const _require = createRequire(import.meta.url);
function getVersion(): string {
  try {
    return _require("../../package.json").version || WEAVETAB_VERSION;
  } catch {
    return WEAVETAB_VERSION;
  }
}

import {
  getVerifiedPackages,
  resolvePluginTrust,
  resolvePluginCandidates,
  invalidateRegistryCache,
  OFFICIAL_PLUGIN_PREFIX,
  REGISTRY_URL,
  type PluginCandidate,
} from "../plugin/registry.js";
import { listInstalledPlugins, inspectInstalledPackage, normalizePermissions } from "../plugin/loader.js";

// Helper to run child process safely
function runCommand(cmd: string, cmdArgs: string[], cwd: string = process.cwd()): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const executable = isWin && !cmd.endsWith(".cmd") && !cmd.endsWith(".exe") ? `${cmd}.cmd` : cmd;
    const child = spawn(executable, cmdArgs, {
      cwd,
      shell: isWin,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });

    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });

    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: err.message });
    });
  });
}

function runNpmCommand(cmdArgs: string[], cwd: string = process.cwd()): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCommand("npm", cmdArgs, cwd);
}

/**
 * Resolve a human-readable author from a manifest. Handles every shape the
 * schema allows: a plain `author` string, an `author` object, an `author`
 * array, or the richer `authors[]` array of strings/objects.
 */
function resolveManifestAuthor(manifest: any, fallback: string): string {
  const pick = (value: any): string | null => {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      for (const entry of value) {
        const name = pick(entry);
        if (name) return name;
      }
    } else if (value && typeof value === "object" && typeof value.name === "string" && value.name.trim()) {
      return value.name.trim();
    }
    return null;
  };

  return pick(manifest?.author) || pick(manifest?.authors) || fallback;
}

// ---------------------------------------------------------------------------
// 1. ADD / INSTALL PLUGIN WITH DISAMBIGUATION
// ---------------------------------------------------------------------------

export async function runPluginAdd(inputName: string, args: string[] = []): Promise<void> {
  if (!inputName || inputName.startsWith("-")) {
    console.log(pc.red("[ERROR] Please provide a package name or local path to install."));
    console.log(pc.dim("Usage: weavetab plugin add <packageName|./local-path> [--official | --community] [--yes]"));
    return;
  }

  // Local path install: `weavetab plugin add ./my-plugin` (npm installs the directory).
  if (
    inputName === "." ||
    inputName.startsWith("./") ||
    inputName.startsWith("../") ||
    inputName.startsWith("file:") ||
    inputName.startsWith("/") ||
    inputName.startsWith("\\") ||
    /^[a-zA-Z]:[\\/]/.test(inputName) ||
    inputName.startsWith("~/")
  ) {
    await runPluginAddLocal(inputName);
    return;
  }

  const isForce = args.includes("--yes") || args.includes("-y") || args.includes("--force");
  const wantOfficial = args.includes("--official") || args.includes("-O");
  const wantCommunity = args.includes("--community") || args.includes("-C");

  const verifiedPackages = await getVerifiedPackages();

  const resolveSpinner = ora(`Resolving package candidates for ${pc.cyan(inputName)}...`).start();
  const candidates = await resolvePluginCandidates(inputName, verifiedPackages);
  resolveSpinner.stop();

  let selectedPkg = inputName;
  let selectedCandidate: PluginCandidate | undefined;

  // Disambiguation Flow
  if (candidates.length > 1) {
    if (wantOfficial) {
      selectedCandidate = candidates.find((c) => c.isOfficialShortcut) || candidates[0];
      selectedPkg = selectedCandidate.packageName;
    } else if (wantCommunity) {
      selectedCandidate = candidates.find((c) => !c.isOfficialShortcut) || candidates[0];
      selectedPkg = selectedCandidate.packageName;
    } else if (process.stdin.isTTY) {
      console.log();
      console.log(
        boxen(
          `${pc.bold(pc.cyan("Multiple plugins match"))} ${pc.yellow(`"${inputName}"`)}\n` +
            pc.dim("Select which package you want to install:"),
          { padding: 1, borderStyle: "round", borderColor: "cyan" }
        )
      );

      const choice = await p.select({
        message: "Choose package to install:",
        options: candidates.map((c) => {
          const tierTag =
            c.tier === "official"
              ? pc.bgBlue(pc.white(" Official "))
              : c.tier === "verified"
              ? pc.bgGreen(pc.black(" Verified "))
              : pc.bgYellow(pc.black(" Unverified "));

          return {
            value: c.packageName,
            label: `${tierTag} ${pc.bold(c.packageName)}`,
            hint: c.tooltip,
          };
        }),
      });

      if (p.isCancel(choice)) {
        p.cancel("Installation aborted.");
        return;
      }
      selectedPkg = choice as string;
      selectedCandidate = candidates.find((c) => c.packageName === selectedPkg);
    } else {
      // Non-interactive fallback: Prefer official shortcut if available
      selectedCandidate = candidates.find((c) => c.isOfficialShortcut) || candidates[0];
      selectedPkg = selectedCandidate.packageName;
      console.log(pc.dim(`[AUTO] Selected candidate: ${selectedPkg}`));
    }
  } else if (candidates.length === 1) {
    selectedCandidate = candidates[0];
    selectedPkg = selectedCandidate.packageName;
  }

  const trust = selectedCandidate
    ? { tier: selectedCandidate.tier, label: selectedCandidate.label, badge: selectedCandidate.badge, tooltip: selectedCandidate.tooltip }
    : resolvePluginTrust(selectedPkg, verifiedPackages);

  console.log();
  console.log(boxen(pc.bold(pc.cyan(" WEAVETAB PLUGIN INSTALL ")), { padding: 0, borderStyle: "round", borderColor: "cyan" }));
  console.log();

  // Trust Resolution & Security Guard
  if (trust.tier === "official") {
    console.log(`${pc.bgBlue(pc.white(" OFFICIAL "))} ${pc.green(selectedPkg)}`);
    console.log(pc.dim("  Author: Weavetab Core Team"));
    console.log(pc.dim("  Security: Audited and cryptographically trusted first-party package.\n"));
  } else if (trust.tier === "verified") {
    console.log(`${pc.bgGreen(pc.black(" VERIFIED "))} ${pc.green(selectedPkg)}`);
    console.log(pc.dim("  Status: Listed in Weavetab Community Verified Registry."));
    console.log(pc.dim("  Security: Reviewed by Weavetab maintainers.\n"));
  } else {
    // Unverified Tier: Show prominent warning banner
    const warningMessage = [
      pc.bold(pc.yellow("⚠️  SECURITY WARNING: UNVERIFIED COMMUNITY PLUGIN")),
      "",
      `Package ${pc.bold(pc.yellow(`"${selectedPkg}"`))} is NOT verified by Weavetab.`,
      pc.dim("It is an unvetted third-party package and may potentially contain:"),
      `  • ${pc.red("Arbitrary code execution")} during installation or runtime`,
      `  • ${pc.red("CDP browser control")} (evaluating scripts, stealing session cookies)`,
      `  • ${pc.red("Network or File System access")} (exfiltrating sensitive credentials)`,
      "",
      pc.bold(pc.yellow("Install and run this plugin strictly at your own risk!")),
    ].join("\n");

    console.log(
      boxen(warningMessage, {
        padding: 1,
        borderStyle: "double",
        borderColor: "yellow",
      })
    );
    console.log();

    if (!isForce) {
      if (!process.stdin.isTTY) {
        console.log(pc.red("[ERROR] Unverified plugin cannot be installed in non-interactive mode without --yes flag."));
        return;
      }

      const proceed = await p.confirm({
        message: pc.yellow(`Do you want to proceed with installing unverified package "${selectedPkg}"?`),
        initialValue: false,
      });

      if (p.isCancel(proceed) || !proceed) {
        p.cancel("Installation aborted for safety.");
        return;
      }
    }
  }

  // Run npm install
  const spinner = ora(`Installing ${pc.cyan(selectedPkg)} via npm...`).start();
  const installResult = await runNpmCommand(["install", selectedPkg]);

  if (installResult.code !== 0) {
    spinner.fail(pc.red(`Failed to install ${selectedPkg}`));
    if (installResult.stderr) {
      console.error(pc.dim(installResult.stderr));
    }
    return;
  }

  spinner.succeed(pc.green(`installed ${pc.bold(selectedPkg)}`));

  // Inspect installed package for weavetab.json
  const targetDir = path.join(process.cwd(), "node_modules", selectedPkg);
  const installedInfo = inspectInstalledPackage(targetDir);

  if (installedInfo && installedInfo.manifest) {
    const manifest = installedInfo.manifest;
    const tools = manifest.tools || [];
    const permissions = normalizePermissions(manifest.permissions);

    const infoLines = [
      `${pc.bold("Plugin Details:")}`,
      `  ${pc.dim("Name:")}        ${manifest.name || selectedPkg}`,
      `  ${pc.dim("Version:")}     ${manifest.version || "1.0.0"}`,
      `  ${pc.dim("Author:")}      ${resolveManifestAuthor(manifest, "Community")}`,
      `  ${pc.dim("Trust Tier:")}  ${trust.badge}`,
      `  ${pc.dim("Description:")} ${manifest.description || "No description provided"}`,
    ];

    if (tools.length > 0) {
      infoLines.push("", `${pc.bold(`Exposed Tools (${tools.length}):`)}`);
      for (const tool of tools) {
        infoLines.push(`  • ${pc.cyan(tool.name)}: ${pc.dim(tool.description || "")}`);
      }
    }

    const permsList: string[] = [];
    if (permissions.network) permsList.push(`Network (${permissions.network.reason || "unspecified"})`);
    if (permissions.cdp) permsList.push(`CDP (${permissions.cdp.reason || "unspecified"})`);
    if (permissions.fs) permsList.push(`FileSystem (${permissions.fs.reason || "unspecified"})`);
    if (permissions.tools?.override?.length) {
      permsList.push(`Tool Overrides: [${permissions.tools.override.join(", ")}] (${permissions.tools.reason || "unspecified"})`);
    }
    if (permissions.tools?.remove?.length) {
      permsList.push(`Tool Removals: [${permissions.tools.remove.join(", ")}] (${permissions.tools.reason || "unspecified"})`);
    }

    if (permsList.length > 0) {
      infoLines.push("", `${pc.bold("Requested Permissions & Modifications:")}`);
      for (const perm of permsList) {
        infoLines.push(`  • ${pc.yellow(perm)}`);
      }
    }

    console.log();
    console.log(boxen(infoLines.join("\n"), { padding: 1, borderStyle: "round", borderColor: "green" }));
    console.log();
    console.log(pc.green("✔ Plugin is ready to use! Restart Weavetab MCP server to activate changes.\n"));
  } else {
    console.log();
    console.log(
      boxen(
        `${pc.yellow("⚠️  NOTE: No 'weavetab.json' manifest was detected inside this package.")}\n` +
          pc.dim("Weavetab requires a valid weavetab.json manifest to automatically register tools.\n") +
          pc.dim(`If you are the author, build the plugin using the developer SDK: ${pc.cyan("npx @weavetab/sdk build")}`),
        { padding: 1, borderStyle: "round", borderColor: "yellow" }
      )
    );
    console.log();
  }
}

// ---------------------------------------------------------------------------
// 1b. ADD FROM LOCAL PATH (`weavetab plugin add ./my-plugin`)
// ---------------------------------------------------------------------------

export async function runPluginAddLocal(inputPath: string): Promise<void> {
  let dir = inputPath;
  if (dir.startsWith("file:")) dir = dir.slice("file:".length);
  if (dir.startsWith("~/")) dir = path.join(process.env.HOME || process.env.USERPROFILE || "", dir.slice(2));
  const absDir = path.resolve(process.cwd(), dir);

  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    console.log(pc.red(`[ERROR] Local path not found: ${inputPath}`));
    return;
  }
  const local = inspectInstalledPackage(absDir);
  if (!local) {
    console.log(pc.red(`[ERROR] No valid weavetab.json manifest in ${absDir}`));
    console.log(pc.dim("Scaffold one with: npx @weavetab/sdk init <name>"));
    return;
  }

  const spinner = ora(`Installing local plugin ${pc.cyan(local.packageName)} from ${pc.dim(absDir)} via npm...`).start();
  const installResult = await runNpmCommand(["install", absDir]);
  if (installResult.code !== 0) {
    spinner.fail(pc.red(`Failed to install ${local.packageName}`));
    if (installResult.stderr) console.error(pc.dim(installResult.stderr));
    return;
  }
  spinner.succeed(pc.green(`installed ${pc.bold(local.packageName)} (local path)`));

  const targetDir = path.join(process.cwd(), "node_modules", local.packageName);
  const installedInfo = fs.existsSync(targetDir) ? inspectInstalledPackage(targetDir) : local;
  const manifest = (installedInfo?.manifest || local.manifest) as any;
  const tools = manifest.tools || [];
  console.log();
  console.log(boxen(
    `${pc.bold("Plugin Details:")}\n` +
    `  ${pc.dim("Name:")}        ${manifest.name || local.packageName}\n` +
    `  ${pc.dim("Version:")}     ${manifest.version || "1.0.0"}\n` +
    `  ${pc.dim("Source:")}      ${absDir} (local path)\n` +
    `  ${pc.dim("Description:")} ${manifest.description || "No description provided"}` +
    (tools.length > 0 ? `\n\n${pc.bold(`Exposed Tools (${tools.length}):`)}` + tools.map((t: any) => `\n  • ${pc.cyan(t.name)}: ${pc.dim(t.description || "")}`).join("") : ""),
    { padding: 1, borderStyle: "round", borderColor: "green" }
  ));
  console.log();
  console.log(pc.green("✔ Plugin is ready to use! Restart Weavetab MCP server to activate changes.\n"));
}

// ---------------------------------------------------------------------------
// 2. LIST INSTALLED PLUGINS
// ---------------------------------------------------------------------------

export async function runPluginList(): Promise<void> {
  const verifiedPackages = await getVerifiedPackages();
  const plugins = listInstalledPlugins();

  console.clear();
  console.log(boxen(pc.bold(pc.cyan(" INSTALLED WEAVETAB PLUGINS ")), { padding: 0, borderStyle: "round", borderColor: "cyan" }));
  console.log();

  if (plugins.length === 0) {
    console.log(pc.dim("No Weavetab plugins found in the local node_modules directory."));
    console.log(pc.dim(`Install official or community plugins using: ${pc.cyan("weavetab plugin add <packageName>")}\n`));
    return;
  }

  console.log(pc.dim(`Found ${plugins.length} installed plugin(s):\n`));

  for (const pInfo of plugins) {
    const trust = resolvePluginTrust(pInfo.packageName, verifiedPackages);
    const m = pInfo.manifest;
    const toolCount = m.tools?.length ?? 0;

    console.log(`${trust.badge} ${pc.bold(pc.cyan(pInfo.packageName))} ${pc.dim(`v${m.version || "1.0.0"}`)}`);
    console.log(`  ${pc.dim("Author:")}      ${resolveManifestAuthor(m, "Unknown")}`);
    console.log(`  ${pc.dim("Description:")} ${m.description || "(none)"}`);
    console.log(`  ${pc.dim("Tools:")}       ${toolCount} tool(s) registered`);

    if (m.tools && m.tools.length > 0) {
      const toolNames = m.tools.map((t) => pc.green(t.name)).join(", ");
      console.log(`  ${pc.dim("Tool Names:")}  ${toolNames}`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// 3. SEARCH PLUGINS (OFFICIAL & VERIFIED REGISTRY + NPM)
// ---------------------------------------------------------------------------

export async function runPluginSearch(query?: string): Promise<void> {
  const q = (query || "").toLowerCase().trim();
  const spinner = ora(`Searching Weavetab plugin registry for "${pc.cyan(q || "*")}"...`).start();

  const verifiedPackages = await getVerifiedPackages();
  const results: Array<{ name: string; tier: string; badge: string; description: string; author: string }> = [];

  // 1. Search verified registry
  for (const pkgName of verifiedPackages) {
    if (!q || pkgName.toLowerCase().includes(q)) {
      results.push({
        name: pkgName,
        tier: "verified",
        badge: pc.bgGreen(pc.black(" Verified ")),
        description: "Community plugin listed in verified registry",
        author: "Community",
      });
    }
  }

  // 2. Query npm search
  try {
    const searchQuery = q ? `weavetab ${q}` : "weavetab plugin";
    const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(searchQuery)}&size=15`, {
      signal: AbortSignal.timeout(3500),
      headers: { "User-Agent": `Weavetab/${getVersion()}` },
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      if (Array.isArray(data.objects)) {
        for (const item of data.objects) {
          const pkg = item.package;
          if (!pkg || results.some((r) => r.name === pkg.name)) continue;

          const trust = resolvePluginTrust(pkg.name, verifiedPackages);
          results.push({
            name: pkg.name,
            tier: trust.tier,
            badge:
              trust.tier === "official"
                ? pc.bgBlue(pc.white(" Official "))
                : trust.tier === "verified"
                ? pc.bgGreen(pc.black(" Verified "))
                : pc.bgYellow(pc.black(" Unverified ")),
            description: pkg.description || "No description provided",
            author: pkg.publisher?.username || pkg.author?.name || "Community",
          });
        }
      }
    }
  } catch { /* offline / network error */ }

  spinner.stop();

  console.log();
  console.log(boxen(pc.bold(pc.cyan(` PLUGIN SEARCH RESULTS: "${q || "all"}" `)), { padding: 0, borderStyle: "round", borderColor: "cyan" }));
  console.log();

  if (results.length === 0) {
    console.log(pc.yellow(`No plugins matching "${q}" found.`));
    console.log(pc.dim(`Try browsing the registry or visit ${pc.cyan("https://github.com/weavetab/mcp/plugins")}\n`));
    return;
  }

  console.log(pc.dim(`Found ${results.length} matching plugin(s):\n`));

  for (const item of results) {
    console.log(`${item.badge} ${pc.bold(pc.cyan(item.name))} ${pc.dim(`by ${item.author}`)}`);
    console.log(`  ${pc.dim(item.description)}`);
    console.log(`  ${pc.dim("Install:")} ${pc.green(`weavetab plugin add ${item.name}`)}`);
    console.log();
  }
}

// ---------------------------------------------------------------------------
// 4. BROWSE & ONE-CLICK INSTALL (TERMINAL MARKETPLACE)
// ---------------------------------------------------------------------------

export async function runPluginBrowse(): Promise<void> {
  console.clear();
  p.intro(`${pc.bgCyan(pc.black(" Weavetab Plugins "))}  ${pc.cyan("Interactive Plugin Explorer")}`);

  const spinner = p.spinner();
  spinner.start("Fetching plugin registry...");

  const verifiedPackages = await getVerifiedPackages();
  const installedList = listInstalledPlugins();
  const installedSet = new Set(installedList.map((i) => i.packageName));

  const items: Array<{ value: string; label: string; hint: string }> = [];

  for (const pkg of verifiedPackages) {
    const isInstalled = installedSet.has(pkg);
    const status = isInstalled ? pc.green(" [Installed]") : "";
    items.push({
      value: pkg,
      label: `${pc.bgGreen(pc.black(" Verified "))} ${pc.bold(pkg)}${status}`,
      hint: isInstalled ? "Already installed. Select to reinstall or inspect." : "Verified community plugin. Press Enter to install.",
    });
  }

  spinner.stop(`Found ${items.length} verified plugin(s) in registry.`);

  if (items.length === 0) {
    p.note("No plugins currently in registry.", "Weavetab Plugins");
    return;
  }

  items.push({
    value: "__search__",
    label: `${pc.cyan("🔍 Search for community plugins on npm...")}`,
    hint: "Search for third-party community plugins",
  });

  const selected = await p.select({
    message: "Select a plugin to install or inspect:",
    options: items,
  });

  if (p.isCancel(selected)) {
    p.cancel("Closed plugin explorer.");
    return;
  }

  if (selected === "__search__") {
    const query = await p.text({
      message: "Search query:",
      placeholder: "e.g. vision, notion, search",
    });
    if (p.isCancel(query)) return;
    await runPluginSearch(query as string);
    return;
  }

  await runPluginAdd(selected as string);
}

// ---------------------------------------------------------------------------
// 5. REMOVE / UNINSTALL PLUGIN
// ---------------------------------------------------------------------------

export async function runPluginRemove(pkgName: string, args: string[] = []): Promise<void> {
  if (!pkgName || pkgName.startsWith("-")) {
    console.log(pc.red("[ERROR] Please specify the package name to remove."));
    console.log(pc.dim("Usage: weavetab plugin remove <packageName>"));
    return;
  }

  const spinner = ora(`Uninstalling ${pc.cyan(pkgName)} via npm...`).start();
  const result = await runNpmCommand(["uninstall", pkgName]);

  if (result.code !== 0) {
    spinner.fail(pc.red(`Failed to remove ${pkgName}`));
    if (result.stderr) console.error(pc.dim(result.stderr));
    return;
  }

  spinner.succeed(pc.green(`removed ${pc.bold(pkgName)}`));
  console.log(pc.dim("The plugin and its tools have been uninstalled.\n"));
}

// ---------------------------------------------------------------------------
// 6. VERIFY / CHECK PLUGIN TRUST
// ---------------------------------------------------------------------------

export async function runPluginVerify(pkgName: string): Promise<void> {
  if (!pkgName || pkgName.startsWith("-")) {
    console.log(pc.red("[ERROR] Please specify a package name to verify."));
    console.log(pc.dim("Usage: weavetab plugin verify <packageName>"));
    return;
  }

  const spinner = ora(`Checking trust status for ${pc.cyan(pkgName)}...`).start();
  const verifiedPackages = await getVerifiedPackages();
  spinner.stop();

  const trust = resolvePluginTrust(pkgName, verifiedPackages);

  console.log();
  console.log(boxen(pc.bold(pc.cyan(` PLUGIN TRUST REPORT: ${pkgName} `)), { padding: 0, borderStyle: "round", borderColor: "cyan" }));
  console.log();
  console.log(`  ${pc.dim("Package:")}    ${pc.bold(pkgName)}`);
  console.log(`  ${pc.dim("Tier:")}       ${trust.badge} (${trust.label})`);
  console.log(`  ${pc.dim("Details:")}    ${trust.tooltip}`);
  console.log();

  if (trust.tier === "unverified") {
    console.log(pc.yellow("  Want to get this package verified?"));
    console.log(pc.dim(`  Submit a verification PR to the registry at: ${pc.cyan(REGISTRY_URL)}\n`));
  }
}

// ---------------------------------------------------------------------------
// 7. MAIN CLI ROUTER FOR PLUGINS (User / Operations Mode)
// ---------------------------------------------------------------------------

export async function runPluginCli(args: string[]): Promise<void> {
  if (args.includes("--refresh")) {
    invalidateRegistryCache();
    console.log(pc.green("[OK] Plugin registry cache refreshed.\n"));
  }

  const cleanArgs = args.filter((a) => a !== "--refresh");
  const subcmd = cleanArgs[0]?.toLowerCase();

  if (!subcmd || subcmd === "--help" || subcmd === "-h" || subcmd === "help") {
    console.log();
    console.log(boxen(pc.bold(pc.cyan(" WEAVETAB PLUGIN MANAGER ")), { padding: 0, borderStyle: "round", borderColor: "cyan" }));
    console.log();
    console.log(pc.bold("USAGE"));
    console.log(`  weavetab plugin <command> [options]`);
    console.log();
    console.log(pc.bold("COMMANDS"));
    console.log(`  ${pc.cyan("add <pkg|path>")}     Install a plugin by npm name or local path (e.g. @acme/weavetab-plugin, ./my-plugin)`);
    console.log(`  ${pc.cyan("browse")}             Interactive terminal explorer to browse & 1-click install`);
    console.log(`  ${pc.cyan("search [query]")}     Search plugins across official registry & npm`);
    console.log(`  ${pc.cyan("list")}               List all installed plugins and their registered tools`);
    console.log(`  ${pc.cyan("remove <pkg>")}       Uninstall a plugin from local environment`);
    console.log(`  ${pc.cyan("verify <pkg>")}       Check trust tier and registry verification status`);
    console.log();
    console.log(pc.bold("DEVELOPER SDK (@weavetab/sdk)"));
    console.log(`  ${pc.dim("Scaffold a plugin:")}  ${pc.cyan("npx @weavetab/sdk init <name>")}`);
    console.log(`  ${pc.dim("Build & validate:")}   ${pc.cyan("npx @weavetab/sdk build")}`);
    console.log();
    console.log(pc.bold("OPTIONS (for 'add' / general)"));
    console.log(`  ${pc.cyan("--refresh")}          Invalidate and refresh the verified plugin cache`);
    console.log(`  ${pc.cyan("--official, -O")}     Prefer official @weavetab/plugin-<name>`);
    console.log(`  ${pc.cyan("--community, -C")}    Prefer community package`);
    console.log(`  ${pc.cyan("--yes, -y")}          Bypass interactive warning prompt for unverified plugins`);
    console.log();
    return;
  }

  if (subcmd === "init" || subcmd === "create" || subcmd === "new" || subcmd === "build" || subcmd === "manifest") {
    console.log(pc.yellow(`\n[Weavetab] Plugin authoring commands belong to the developer SDK (@weavetab/sdk).`));
    console.log(pc.dim("To scaffold a new plugin:   ") + pc.cyan("npx @weavetab/sdk init <name>"));
    console.log(pc.dim("To build/validate a plugin: ") + pc.cyan("npx @weavetab/sdk build"));
    console.log(pc.dim("SDK documentation:          ") + pc.cyan("https://github.com/weavetab/sdk\n"));
    return;
  }

  if (subcmd === "add" || subcmd === "install" || subcmd === "i") {
    await runPluginAdd(cleanArgs[1], cleanArgs.slice(2));
    return;
  }

  if (subcmd === "browse" || subcmd === "explore") {
    await runPluginBrowse();
    return;
  }

  if (subcmd === "search" || subcmd === "find") {
    await runPluginSearch(cleanArgs[1]);
    return;
  }

  if (subcmd === "list" || subcmd === "ls") {
    await runPluginList();
    return;
  }

  if (subcmd === "remove" || subcmd === "rm" || subcmd === "uninstall") {
    await runPluginRemove(cleanArgs[1], cleanArgs.slice(2));
    return;
  }

  if (subcmd === "verify" || subcmd === "check") {
    await runPluginVerify(cleanArgs[1]);
    return;
  }

  console.log(pc.red(`[ERROR] Unknown plugin subcommand: "${subcmd}"`));
  console.log(pc.dim("Run 'weavetab plugin --help' to see available commands."));
}
