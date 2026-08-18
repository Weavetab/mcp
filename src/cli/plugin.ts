import * as p from "@clack/prompts";
import pc from "picocolors";
import boxen from "boxen";
import ora from "ora";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import {
  getVerifiedPackages,
  resolvePluginTrust,
  resolvePluginCandidates,
  OFFICIAL_PLUGIN_PREFIX,
  REGISTRY_URL,
  type PluginCandidate,
} from "../plugin/registry.js";
import { listInstalledPlugins, inspectInstalledPackage } from "../plugin/loader.js";
import type { WeavetabManifest, WeavetabManifestTool } from "../plugin/interface.js";

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

// ---------------------------------------------------------------------------
// 1. ADD / INSTALL PLUGIN WITH DISAMBIGUATION
// ---------------------------------------------------------------------------

export async function runPluginAdd(inputName: string, args: string[] = []): Promise<void> {
  if (!inputName || inputName.startsWith("-")) {
    console.log(pc.red("[ERROR] Please provide a package name to install."));
    console.log(pc.dim("Usage: wt plugin add <packageName> [--official | --community] [--yes]"));
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

  spinner.succeed(pc.green(`Successfully installed ${pc.bold(selectedPkg)}`));

  // Inspect installed package for weavetab.json
  const targetDir = path.join(process.cwd(), "node_modules", selectedPkg);
  const installedInfo = inspectInstalledPackage(targetDir);

  if (installedInfo && installedInfo.manifest) {
    const manifest = installedInfo.manifest;
    const tools = manifest.tools || [];
    const permissions = manifest.permissions || {};

    const infoLines = [
      `${pc.bold("Plugin Details:")}`,
      `  ${pc.dim("Name:")}        ${manifest.name || selectedPkg}`,
      `  ${pc.dim("Version:")}     ${manifest.version || "1.0.0"}`,
      `  ${pc.dim("Author:")}      ${manifest.author || "Community"}`,
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
          pc.dim(`If you are the author, run ${pc.cyan("wt plugin init")} in the package directory to generate one.`),
        { padding: 1, borderStyle: "round", borderColor: "yellow" }
      )
    );
    console.log();
  }
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
    console.log(pc.dim(`Install official or community plugins using: ${pc.cyan("wt plugin add <packageName>")}\n`));
    return;
  }

  console.log(pc.dim(`Found ${plugins.length} installed plugin(s):\n`));

  for (const pInfo of plugins) {
    const trust = resolvePluginTrust(pInfo.packageName, verifiedPackages);
    const m = pInfo.manifest;
    const toolCount = m.tools?.length ?? 0;

    console.log(`${trust.badge} ${pc.bold(pc.cyan(pInfo.packageName))} ${pc.dim(`v${m.version || "1.0.0"}`)}`);
    console.log(`  ${pc.dim("Author:")}      ${m.author || "Unknown"}`);
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
      headers: { "User-Agent": "Weavetab-CLI/2.5.0" },
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
    console.log(pc.dim(`Try browsing the registry or visit ${pc.cyan("https://weavetab.dev/plugins")}\n`));
    return;
  }

  console.log(pc.dim(`Found ${results.length} matching plugin(s):\n`));

  for (const item of results) {
    console.log(`${item.badge} ${pc.bold(pc.cyan(item.name))} ${pc.dim(`by ${item.author}`)}`);
    console.log(`  ${pc.dim(item.description)}`);
    console.log(`  ${pc.dim("Install:")} ${pc.green(`wt plugin add ${item.name}`)}`);
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
    console.log(pc.dim("Usage: wt plugin remove <packageName>"));
    return;
  }

  const spinner = ora(`Uninstalling ${pc.cyan(pkgName)} via npm...`).start();
  const result = await runNpmCommand(["uninstall", pkgName]);

  if (result.code !== 0) {
    spinner.fail(pc.red(`Failed to remove ${pkgName}`));
    if (result.stderr) console.error(pc.dim(result.stderr));
    return;
  }

  spinner.succeed(pc.green(`Successfully removed ${pc.bold(pkgName)}`));
  console.log(pc.dim("The plugin and its tools have been uninstalled.\n"));
}

// ---------------------------------------------------------------------------
// 6. VERIFY / CHECK PLUGIN TRUST
// ---------------------------------------------------------------------------

export async function runPluginVerify(pkgName: string): Promise<void> {
  if (!pkgName || pkgName.startsWith("-")) {
    console.log(pc.red("[ERROR] Please specify a package name to verify."));
    console.log(pc.dim("Usage: wt plugin verify <packageName>"));
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
// 7. ENTERPRISE INIT: SCAFFOLD WEAVETAB PLUGIN
// ---------------------------------------------------------------------------

const DEFAULT_LOGO_SVG = `<svg width="128" height="128" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="128" height="128" rx="28" fill="#0D1117"/>
  <rect x="2" y="2" width="124" height="124" rx="26" stroke="#30363D" stroke-width="2"/>
  <path d="M64 24L104 64L64 104L24 64L64 24Z" fill="url(#blue_grad)" stroke="#58A6FF" stroke-width="3"/>
  <circle cx="64" cy="64" r="14" fill="#FFFFFF"/>
  <defs>
    <linearGradient id="blue_grad" x1="24" y1="24" x2="104" y2="104" gradientUnits="userSpaceOnUse">
      <stop stop-color="#2F81F7"/>
      <stop offset="1" stop-color="#1F6FEB"/>
    </linearGradient>
  </defs>
</svg>`;

const DEFAULT_BANNER_SVG = `<svg width="1200" height="400" viewBox="0 0 1200 400" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="400" fill="#0D1117"/>
  <circle cx="600" cy="200" r="260" fill="#2F81F7" fill-opacity="0.12" filter="blur(80px)"/>
  <path d="M600 80L720 200L600 320L480 200L600 80Z" fill="url(#grad)" stroke="#58A6FF" stroke-width="4"/>
  <text x="600" y="360" text-anchor="middle" fill="#E6EDF3" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="28" font-weight="600" letter-spacing="2">WEAVETAB MCP PLUGIN</text>
  <defs>
    <linearGradient id="grad" x1="480" y1="80" x2="720" y2="320" gradientUnits="userSpaceOnUse">
      <stop stop-color="#388BFD"/>
      <stop offset="1" stop-color="#1F6FEB"/>
    </linearGradient>
  </defs>
</svg>`;

export async function runPluginInit(args: string[] = []): Promise<void> {
  const isYes = args.includes("--yes") || args.includes("-y");
  const targetDirName = args.find((a) => !a.startsWith("-")) || "";

  let targetDir = process.cwd();
  if (targetDirName) {
    targetDir = path.resolve(process.cwd(), targetDirName);
    if (!existsSync(targetDir)) {
      await fs.mkdir(targetDir, { recursive: true });
    }
  }

  if (process.stdin.isTTY && !isYes) {
    console.clear();
    p.intro(`${pc.bgBlue(pc.white(" WEAVETAB "))}  ${pc.bold(pc.cyan("Enterprise Plugin Generator"))}`);
  }

  let defaultName = path.basename(targetDir);
  let defaultPkgName = defaultName.startsWith("wt-") ? defaultName : `wt-${defaultName}`;

  let pkgName = defaultPkgName;
  let displayName = defaultName.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  let description = "Weavetab Model Context Protocol (MCP) browser automation plugin.";
  let authorName = "Developer";
  let authorRole = "Maintainer";
  let templateType = "cdp";

  if (process.stdin.isTTY && !isYes) {
    const enteredPkgName = await p.text({
      message: "NPM Package Identifier (e.g. @org/wt-plugin or wt-plugin):",
      defaultValue: defaultPkgName,
      placeholder: defaultPkgName,
    });
    if (p.isCancel(enteredPkgName)) process.exit(0);
    pkgName = enteredPkgName as string;

    const enteredDisplayName = await p.text({
      message: "Human-readable Display Name:",
      defaultValue: displayName,
      placeholder: displayName,
    });
    if (p.isCancel(enteredDisplayName)) process.exit(0);
    displayName = enteredDisplayName as string;

    const enteredDesc = await p.text({
      message: "Description:",
      defaultValue: description,
      placeholder: description,
    });
    if (p.isCancel(enteredDesc)) process.exit(0);
    description = enteredDesc as string;

    const enteredAuthor = await p.text({
      message: "Author Name or GitHub handle:",
      defaultValue: authorName,
      placeholder: authorName,
    });
    if (p.isCancel(enteredAuthor)) process.exit(0);
    authorName = enteredAuthor as string;

    const enteredRole = await p.text({
      message: "Author Role (custom, e.g. Maintainer, Core Contributor, Creator):",
      defaultValue: "Maintainer",
      placeholder: "Maintainer",
      validate: (val) => {
        if (val && val.trim().length < 3) return "Role must be at least 3 characters long.";
      },
    });
    if (p.isCancel(enteredRole)) process.exit(0);
    authorRole = (enteredRole as string)?.trim() || "Maintainer";

    const selectedTemplate = await p.select({
      message: "Select Plugin Architecture Template:",
      options: [
        {
          value: "cdp",
          label: `${pc.bold(pc.cyan("CDP Browser Automation"))} (Evaluates DOM, clicks elements, inspects tabs)`,
        },
        {
          value: "api",
          label: `${pc.bold(pc.green("External API Connector"))} (Exposes specialized MCP tools with JSON Schemas)`,
        },
        {
          value: "minimal",
          label: `${pc.bold(pc.gray("Minimal Starter"))} (Barebones TypeScript scaffold)`,
        },
      ],
    });
    if (p.isCancel(selectedTemplate)) process.exit(0);
    templateType = selectedTemplate as string;
  }

  const spinner = ora(`Scaffolding enterprise plugin in ${pc.cyan(targetDir)}...`).start();

  // 1. Create directories
  const srcDir = path.join(targetDir, "src");
  const imgDir = path.join(targetDir, "images");
  const testDir = path.join(targetDir, "test");
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(imgDir, { recursive: true });
  await fs.mkdir(testDir, { recursive: true });

  // 2. Assets (Logo & Banner)
  await fs.writeFile(path.join(imgDir, "logo.svg"), DEFAULT_LOGO_SVG, "utf-8");
  await fs.writeFile(path.join(imgDir, "banner.svg"), DEFAULT_BANNER_SVG, "utf-8");

  // 3. package.json
  const packageJsonContent = {
    name: pkgName,
    version: "1.0.0",
    description,
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    type: "module",
    files: ["dist", "images", "weavetab.json", "README.md"],
    scripts: {
      build: "tsc",
      watch: "tsc -w",
      prepare: "weavetab build",
      test: "node --test test/plugin.test.js",
    },
    keywords: [
      "weavetab",
      "weavetab-plugin",
      "mcp",
      "model-context-protocol",
      "browser-automation",
    ],
    author: authorName,
    license: "MIT",
    devDependencies: {
      typescript: "^5.7.2",
    },
  };
  await fs.writeFile(path.join(targetDir, "package.json"), JSON.stringify(packageJsonContent, null, 2), "utf-8");

  // 4. tsconfig.json
  const tsConfigContent = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      outDir: "./dist",
      rootDir: "./src",
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    include: ["src/**/*"],
  };
  await fs.writeFile(path.join(targetDir, "tsconfig.json"), JSON.stringify(tsConfigContent, null, 2), "utf-8");

  // 5. .gitignore
  const gitignoreContent = `node_modules/
dist/
*.log
.DS_Store
`;
  await fs.writeFile(path.join(targetDir, ".gitignore"), gitignoreContent, "utf-8");

  // 6. src/index.ts
  const sanitizedFnName = pkgName.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  const sourceCode = `/**
 * ${displayName}
 * Model Context Protocol (MCP) Plugin for Weavetab
 * Author: ${authorName}
 * License: MIT
 */

export interface WeavetabSession {
  evaluate<T = any>(script: string): Promise<T>;
  click?(selector: string): Promise<any>;
}

export interface PluginToolArgs {
  query?: string;
}

export interface WeavetabPluginTool {
  name: string;
  description: string;
  schema?: Record<string, any>;
  handler: (args: PluginToolArgs, session?: WeavetabSession, config?: any) => Promise<any>;
}

export interface WeavetabPluginDefinition {
  name: string;
  version: string;
  description: string;
  tools: WeavetabPluginTool[];
}

export const plugin: WeavetabPluginDefinition = {
  name: "${pkgName}",
  version: "1.0.0",
  description: "${description}",
  tools: [
    {
      name: "${sanitizedFnName}",
      description: "Inspects live DOM telemetry and executes actions on the active browser tab.",
      schema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional query or CSS selector for DOM inspection."
          }
        }
      },
      handler: async (args: PluginToolArgs, session?: WeavetabSession) => {
        if (!session || typeof session.evaluate !== "function") {
          return {
            status: "error",
            error: "No active Chrome DevTools Protocol (CDP) session attached."
          };
        }

        try {
          const pageData = await session.evaluate(\`
            (() => {
              return {
                title: document.title,
                url: window.location.href,
                elementsCount: document.querySelectorAll("*").length,
                ready: document.readyState
              };
            })()
          \`);

          return {
            status: "success",
            data: pageData,
            query: args?.query || null
          };
        } catch (err: any) {
          return {
            status: "error",
            error: err.message || String(err)
          };
        }
      }
    }
  ]
};

export default plugin;
`;
  await fs.writeFile(path.join(srcDir, "index.ts"), sourceCode, "utf-8");

  // 7. weavetab.json
  const authorHandle = authorName.replace(/^@/, "").trim();
  const isGenericAuthor = ["author", "maintainer", "developer", "user"].includes(authorHandle.toLowerCase());
  const authorGhUrl = authorName.startsWith("http")
    ? authorName
    : (!isGenericAuthor && authorHandle && !authorHandle.includes(" "))
    ? `https://github.com/${authorHandle}`
    : undefined;

  const nodeMajor = process.versions.node ? process.versions.node.split(".")[0] : "18";

  const weavetabManifest: WeavetabManifest = {
    $schema: "https://weavetab.dev/schema/plugin.json",
    name: displayName,
    version: "1.0.0",
    description,
    authors: [
      {
        name: authorHandle || "Author",
        role: authorRole,
        ...(authorGhUrl ? { url: authorGhUrl } : {}),
      },
    ],
    logo: "images/logo.svg",
    banner: "images/banner.svg",
    license: "MIT",
    tags: ["Automation", "Developer Tools", "MCP", "CDP"],
    compatibility: {
      weavetab: "^2.5.0",
      node: `>=${nodeMajor}.0.0`,
    },
    permissions: {
      network: {
        domains: ["*"],
        reason: "Required to inspect web tabs and telemetry.",
      },
      cdp: {
        evaluate: true,
        click: true,
        reason: "Evaluates DOM scripts and queries tab metadata via Chrome DevTools Protocol.",
      },
    },
    tools: [
      {
        name: sanitizedFnName,
        description: `Inspects live DOM telemetry and executes actions on the active browser tab.`,
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Optional query or CSS selector for DOM inspection.",
            },
          },
        },
      },
    ],
  };
  await fs.writeFile(path.join(targetDir, "weavetab.json"), JSON.stringify(weavetabManifest, null, 2), "utf-8");

  // 8. README.md
  const readmeContent = `# ${displayName}

> ${description}

An enterprise Model Context Protocol (MCP) browser extension for **Weavetab**.

## Installation

\`\`\`bash
npx weavetab add ${pkgName}
\`\`\`

## MCP Tools Exposed

| Tool Name | Description | Parameters |
| :--- | :--- | :--- |
| \`${sanitizedFnName}\` | Inspects live DOM telemetry and executes actions on active tab | \`query\` (*optional*) |

## Security & Permissions

- **Chrome DevTools Protocol (CDP)**: Evaluates DOM scripts on active tabs.
- **Network Scope**: Scoped to active browser session.

## Development & Build

\`\`\`bash
# 1. Install dependencies
npm install

# 2. Build and compile plugin manifest
npx weavetab build

# 3. Publish to NPM
npm publish --access public
\`\`\`
`;
  await fs.writeFile(path.join(targetDir, "README.md"), readmeContent, "utf-8");

  // 9. test/plugin.test.js
  const testContent = `import test from "node:test";
import assert from "node:assert/strict";

test("plugin exports valid Weavetab MCP tools", async () => {
  const { plugin } = await import("../dist/index.js");
  assert.ok(plugin, "Plugin module exported");
  assert.equal(typeof plugin.name, "string");
  assert.ok(Array.isArray(plugin.tools), "Plugin exports tools array");
  assert.ok(plugin.tools.length > 0, "Plugin defines at least 1 tool");
});
`;
  await fs.writeFile(path.join(testDir, "plugin.test.js"), testContent, "utf-8");

  spinner.succeed(pc.green(`Scaffolded ${pc.bold(displayName)} successfully!`));

  console.log();
  console.log(
    boxen(
      `${pc.bold(pc.cyan("✨ PLUGIN READY FOR DEVELOPMENT"))}\n\n` +
        `  ${pc.dim("Location:")}     ${pc.bold(targetDir)}\n` +
        `  ${pc.dim("Package:")}      ${pc.green(pkgName)}\n` +
        `  ${pc.dim("Tools:")}        ${pc.yellow(sanitizedFnName)}\n\n` +
        `${pc.bold("Next Steps:")}\n` +
        `  1. ${pc.cyan("npm install")}\n` +
        `  2. ${pc.cyan("npx weavetab build")}   ${pc.dim("(Compiles TS & syncs weavetab.json)")}\n` +
        `  3. ${pc.cyan("npm publish --access public")}`,
      { padding: 1, borderStyle: "round", borderColor: "cyan" }
    )
  );
  console.log();
}

// ---------------------------------------------------------------------------
// 8. ENTERPRISE BUILD: COMPILE & SYNC WEAVETAB.JSON
// ---------------------------------------------------------------------------

export async function runPluginBuild(args: string[] = []): Promise<void> {
  const cwd = process.cwd();
  const pkgPath = path.join(cwd, "package.json");
  const manifestPath = path.join(cwd, "weavetab.json");
  const tsConfigPath = path.join(cwd, "tsconfig.json");

  console.log();
  console.log(boxen(pc.bold(pc.cyan(" WEAVETAB PLUGIN COMPILER ")), { padding: 0, borderStyle: "round", borderColor: "cyan" }));
  console.log();

  if (!existsSync(pkgPath)) {
    console.log(pc.red("[ERROR] No package.json found in current directory."));
    console.log(pc.dim("Run 'wt init' to scaffold a new Weavetab plugin project."));
    return;
  }

  const pkgJson = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
  const isTypeScript = existsSync(tsConfigPath);

  // 1. Compile TypeScript if applicable
  const entryRel = pkgJson.main || (isTypeScript ? "dist/index.js" : "index.js");
  const entryAbs = path.join(cwd, entryRel);

  if (isTypeScript) {
    const compileSpinner = ora("Compiling TypeScript plugin sources...").start();
    const localTsc = path.join(cwd, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
    let compiled = false;
    let lastError = "";

    if (existsSync(localTsc)) {
      const res = await runCommand(localTsc, [], cwd);
      if (res.code === 0) compiled = true;
      else lastError = res.stderr || res.stdout;
    }

    if (!compiled) {
      const npmRes = await runNpmCommand(["run", "build"], cwd);
      if (npmRes.code === 0) compiled = true;
      else lastError = npmRes.stderr || npmRes.stdout;
    }

    if (!compiled) {
      const npxRes = await runCommand("npx", ["-p", "typescript", "tsc"], cwd);
      if (npxRes.code === 0) compiled = true;
      else lastError = npxRes.stderr || npxRes.stdout;
    }

    if (compiled || existsSync(entryAbs)) {
      compileSpinner.succeed(pc.green("TypeScript compiled successfully."));
    } else {
      compileSpinner.fail(pc.red("TypeScript compilation failed."));
      if (lastError) console.error(pc.dim(lastError));
      return;
    }
  }

  // 2. Load compiled plugin module
  const inspectSpinner = ora("Introspecting exported MCP tools and schemas...").start();

  if (!existsSync(entryAbs)) {
    inspectSpinner.fail(pc.red(`Main entrypoint not found: ${entryRel}`));
    console.log(pc.dim("Ensure 'main' in package.json points to a valid compiled JavaScript file."));
    return;
  }

  let exportedTools: WeavetabManifestTool[] = [];
  try {
    const fileUrl = pathToFileURL(entryAbs).href;
    const mod = await import(`${fileUrl}?t=${Date.now()}`);
    const pluginInstance = mod.default || mod.plugin || mod;

    if (pluginInstance && Array.isArray(pluginInstance.tools)) {
      exportedTools = pluginInstance.tools.map((t: any) => {
        const inputSchema = t.inputSchema || t.schema || {
          type: "object",
          properties: {},
        };
        return {
          name: t.name,
          description: t.description || "",
          inputSchema,
        };
      });
    }
    inspectSpinner.succeed(`Discovered ${pc.cyan(String(exportedTools.length))} MCP tool(s).`);
  } catch (err: any) {
    inspectSpinner.warn(pc.yellow(`Dynamic introspection note: ${err.message}`));
  }

  // 3. Read or create weavetab.json
  let manifest: WeavetabManifest = {
    $schema: "https://weavetab.dev/schema/plugin.json",
    name: pkgJson.name || path.basename(cwd),
    version: pkgJson.version || "1.0.0",
    description: pkgJson.description || "",
    logo: "images/logo.svg",
    banner: "images/banner.svg",
    license: pkgJson.license || "MIT",
    tags: ["MCP", "Automation"],
  };

  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf-8"));
    } catch {
      console.log(pc.yellow("Warning: Existing weavetab.json was malformed, rebuilding cleanly."));
    }
  }

  // 4. Synchronize metadata & tools
  manifest.$schema = "https://weavetab.dev/schema/plugin.json";
  manifest.version = pkgJson.version || manifest.version || "1.0.0";
  if (!manifest.description && pkgJson.description) {
    manifest.description = pkgJson.description;
  }

  // Sync authors
  if (!manifest.authors && !manifest.author) {
    manifest.authors = [
      {
        name: pkgJson.author || "Maintainer",
        role: "Maintainer",
      },
    ];
  }

  // Sync compatibility
  if (!manifest.compatibility) {
    const nodeMajor = process.versions.node ? process.versions.node.split(".")[0] : "18";
    manifest.compatibility = {
      weavetab: "^2.5.0",
      node: pkgJson.engines?.node || `>=${nodeMajor}.0.0`,
    };
  }

  // Sync tools array with introspected definitions
  if (exportedTools.length > 0) {
    manifest.tools = exportedTools;
  }

  // Ensure default permissions exist if empty
  if (!manifest.permissions) {
    manifest.permissions = {
      cdp: {
        evaluate: true,
        reason: "Evaluates DOM telemetry and executes automated user actions.",
      },
    };
  }

  // 5. Comprehensive Manifest Validation & Audit Rules
  const errors: string[] = [];
  const warnings: string[] = [];

  // Name validation
  if (!manifest.name || typeof manifest.name !== "string" || manifest.name.trim().length === 0) {
    errors.push("Plugin 'name' is required and cannot be empty.");
  } else if (["my-plugin", "plugin-starter", "plugin-template", "example"].includes(manifest.name.toLowerCase())) {
    warnings.push(`Plugin name '${manifest.name}' appears to be a placeholder. Consider setting a descriptive name.`);
  }

  // Version semver validation
  const semverRegex = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
  if (!manifest.version || !semverRegex.test(manifest.version)) {
    errors.push(`Plugin version '${manifest.version}' is invalid. Must follow Semantic Versioning (e.g. 1.0.0).`);
  }

  // Description validation
  if (!manifest.description || manifest.description.trim().length < 10) {
    warnings.push("Plugin 'description' is missing or very short. Provide a clear summary for users on the registry.");
  }

  // Authors validation
  const authorsList = Array.isArray(manifest.authors)
    ? manifest.authors
    : manifest.author
    ? (Array.isArray(manifest.author) ? manifest.author : [manifest.author])
    : [];

  if (authorsList.length === 0) {
    errors.push("At least one author must be declared in 'authors' or package.json.");
  } else {
    for (const a of authorsList) {
      if (typeof a === "object" && a !== null) {
        if (!a.name || String(a.name).trim().length < 2) {
          errors.push(`Author name '${a.name || ""}' must be at least 2 characters.`);
        }
        if (a.role !== undefined && a.role !== null) {
          const roleStr = String(a.role).trim();
          if (roleStr.length < 3) {
            errors.push(`Invalid author role for '${a.name || "author"}': "${roleStr}". Role must be at least 3 characters (e.g. 'Creator', 'Maintainer', 'Lead Architect').`);
          }
        }
        if (a.url) {
          try {
            const parsedUrl = new URL(a.url);
            if (!["http:", "https:"].includes(parsedUrl.protocol)) {
              errors.push(`Author URL '${a.url}' must use HTTP or HTTPS protocol.`);
            }
          } catch {
            errors.push(`Author URL '${a.url}' is not a valid URL.`);
          }
        }
      }
    }
  }

  // Tools validation
  if (!manifest.tools || manifest.tools.length === 0) {
    warnings.push("No MCP tools declared or discovered. The plugin will not expose any capabilities to AI agents.");
  } else {
    for (const tool of manifest.tools) {
      if (!tool.name || !/^[a-zA-Z0-9_-]+$/.test(tool.name)) {
        errors.push(`Tool name '${tool.name}' is invalid. Must only contain letters, numbers, underscores, or hyphens.`);
      }
      if (!tool.description || tool.description.trim().length < 5) {
        warnings.push(`Tool '${tool.name}' has a very short description. Write a clear description so AI agents understand its purpose.`);
      }
    }
  }

  // Permissions validation
  if (manifest.permissions?.network?.domains?.includes("*")) {
    warnings.push("Wildcard domain access ('*') requested in network permissions. Narrowing to specific domains improves security.");
  }
  if (manifest.permissions?.cdp && (!manifest.permissions.cdp.reason || manifest.permissions.cdp.reason.trim().length < 5)) {
    warnings.push("Missing justification in permissions.cdp.reason. Explain why Chrome DevTools Protocol access is required.");
  }

  // Asset files validation
  if (manifest.logo && typeof manifest.logo === "string") {
    const logoPath = path.resolve(cwd, manifest.logo);
    if (!existsSync(logoPath)) {
      warnings.push(`Referenced logo asset '${manifest.logo}' was not found at '${path.relative(cwd, logoPath)}'.`);
    }
  }
  if (manifest.banner && typeof manifest.banner === "string") {
    const bannerPath = path.resolve(cwd, manifest.banner);
    if (!existsSync(bannerPath)) {
      warnings.push(`Referenced banner asset '${manifest.banner}' was not found at '${path.relative(cwd, bannerPath)}'.`);
    }
  }

  // Print Warnings
  if (warnings.length > 0) {
    console.log();
    console.log(pc.yellow(pc.bold("⚠  WEAVETAB BUILD WARNINGS:")));
    for (const w of warnings) {
      console.log(`  ${pc.yellow("•")} ${w}`);
    }
  }

  // Print Errors and abort if any
  if (errors.length > 0) {
    console.log();
    console.log(pc.red(pc.bold("✖  WEAVETAB BUILD FAILED WITH ERRORS:")));
    for (const e of errors) {
      console.log(`  ${pc.red("•")} ${e}`);
    }
    console.log();
    process.exit(1);
  }

  // 6. Write back synced weavetab.json
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  // 6. Print Summary Report
  const declaredToolsList = manifest.tools?.map((t) => `    • ${pc.bold(pc.cyan(t.name))} - ${pc.dim(t.description)}`).join("\n") || pc.dim("    (None declared)");

  const perms = [];
  if (manifest.permissions?.cdp) perms.push("CDP (Browser Automation)");
  if (manifest.permissions?.network) perms.push(`Network (${manifest.permissions.network.domains?.join(", ") || "Active Tab"})`);
  if (manifest.permissions?.fs) perms.push("Local Filesystem");

  console.log(
    boxen(
      `${pc.bold(pc.green("✔ WEAVETAB PLUGIN BUILD COMPLETED"))}\n\n` +
        `  ${pc.dim("Package:")}        ${pc.bold(pkgJson.name || manifest.name)} (v${manifest.version})\n` +
        `  ${pc.dim("Entrypoint:")}     ${pc.cyan(entryRel)}\n` +
        `  ${pc.dim("Permissions:")}    ${pc.yellow(perms.join(", ") || "Standard")}\n` +
        `  ${pc.dim("Manifest:")}       ${pc.green("weavetab.json (Synced & Validated)")}\n\n` +
        `${pc.bold("Exposed MCP Tools:")}\n${declaredToolsList}\n\n` +
        `${pc.dim("Ready to publish to NPM:")}\n` +
        `  ${pc.bold(pc.cyan("npm publish --access public"))}`,
      { padding: 1, borderStyle: "round", borderColor: "green" }
    )
  );
  console.log();
}

// ---------------------------------------------------------------------------
// 9. MAIN CLI ROUTER FOR PLUGINS
// ---------------------------------------------------------------------------

export async function runPluginCli(args: string[]): Promise<void> {
  const subcmd = args[0]?.toLowerCase();

  if (!subcmd || subcmd === "--help" || subcmd === "-h" || subcmd === "help") {
    console.log();
    console.log(boxen(pc.bold(pc.cyan(" WEAVETAB PLUGIN MANAGER ")), { padding: 0, borderStyle: "round", borderColor: "cyan" }));
    console.log();
    console.log(pc.bold("USAGE"));
    console.log(`  wt plugin <command> [options]`);
    console.log();
    console.log(pc.bold("DEVELOPER COMMANDS"));
    console.log(`  ${pc.cyan("init [name]")}        Scaffold a new enterprise TypeScript Weavetab plugin`);
    console.log(`  ${pc.cyan("build")}              Compile TypeScript & synchronize weavetab.json manifest`);
    console.log(`  ${pc.cyan("manifest")}           Alias for 'build' to validate & sync manifest`);
    console.log();
    console.log(pc.bold("USER COMMANDS"));
    console.log(`  ${pc.cyan("add <pkg>")}          Install a plugin (resolves official @weavetab/ & community)`);
    console.log(`  ${pc.cyan("browse")}             Interactive terminal explorer to browse & 1-click install`);
    console.log(`  ${pc.cyan("search [query]")}     Search plugins across official registry & npm`);
    console.log(`  ${pc.cyan("list")}               List all installed plugins and their registered tools`);
    console.log(`  ${pc.cyan("remove <pkg>")}       Uninstall a plugin from local environment`);
    console.log(`  ${pc.cyan("verify <pkg>")}       Check trust tier and registry verification status`);
    console.log();
    console.log(pc.bold("OPTIONS (for 'add')"));
    console.log(`  ${pc.cyan("--official, -O")}     Prefer official @weavetab/plugin-<name>`);
    console.log(`  ${pc.cyan("--community, -C")}    Prefer community package`);
    console.log(`  ${pc.cyan("--yes, -y")}          Bypass interactive warning prompt for unverified plugins`);
    console.log();
    return;
  }

  if (subcmd === "init" || subcmd === "create" || subcmd === "new") {
    await runPluginInit(args.slice(1));
    return;
  }

  if (subcmd === "build" || subcmd === "manifest" || subcmd === "sync") {
    await runPluginBuild(args.slice(1));
    return;
  }

  if (subcmd === "add" || subcmd === "install" || subcmd === "i") {
    await runPluginAdd(args[1], args.slice(2));
    return;
  }

  if (subcmd === "browse" || subcmd === "explore") {
    await runPluginBrowse();
    return;
  }

  if (subcmd === "search" || subcmd === "find") {
    await runPluginSearch(args[1]);
    return;
  }

  if (subcmd === "list" || subcmd === "ls") {
    await runPluginList();
    return;
  }

  if (subcmd === "remove" || subcmd === "rm" || subcmd === "uninstall") {
    await runPluginRemove(args[1], args.slice(2));
    return;
  }

  if (subcmd === "verify" || subcmd === "check") {
    await runPluginVerify(args[1]);
    return;
  }

  console.log(pc.red(`[ERROR] Unknown plugin subcommand: "${subcmd}"`));
  console.log(pc.dim("Run 'wt plugin --help' to see available commands."));
}
