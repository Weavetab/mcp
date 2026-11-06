import * as p from "@clack/prompts";
import pc from "picocolors";
import boxen from "boxen";
import ora from "ora";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { z } from "zod";
import { WEAVETAB_VERSION } from "../version.js";
import {
  getVerifiedPackages,
  resolvePluginTrust,
  resolvePluginCandidates,
  invalidateRegistryCache,
  REGISTRY_URL,
  type PluginCandidate,
} from "../plugin/registry.js";
import {
  listInstalledPlugins,
  inspectInstalledPackage,
  normalizePermissions,
  loadAndInitPlugin,
  resolveInstalledPluginInfo,
  touchPluginEpoch,
  MAX_AGENTS_MD_LINES,
  MAX_AGENTS_MD_CHARS,
} from "../plugin/loader.js";

function getGlobalPluginDir(): string {
  const dir = path.join(os.homedir(), ".weavetab", "plugins");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({ name: "weavetab-plugins", private: true, dependencies: {} }, null, 2));
  }
  return dir;
}

const _require = createRequire(import.meta.url);
function getVersion(): string {
  try {
    return _require("../../package.json").version || WEAVETAB_VERSION;
  } catch {
    return WEAVETAB_VERSION;
  }
}

function createCliTabProxy(session: any) {
  if (!session?.Runtime) return undefined;
  const ev = async (expression: string) => (await session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true })).result?.value;
  return {
    session,
    isAvailable: () => true,
    url: async () => String((await ev("location.href")) || ""),
    title: async () => String((await ev("document.title")) || ""),
    evaluate: async (fn: any, ...a: any[]) => ev(typeof fn === "function" ? `(${fn})(${a.map((x: any) => JSON.stringify(x)).join(",")})` : fn),
    extract: async (selector: string, mode: "text" | "html" | "value" = "text") => {
      const expr = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        if (${JSON.stringify(mode)} === "html") return el.outerHTML;
        if (${JSON.stringify(mode)} === "value" && "value" in el) return String(el.value);
        return el.textContent?.trim() || "";
      })()`;
      return (await ev(expr)) ?? null;
    },
    waitForSelector: async (selector: string, opts: any = {}) => {
      const timeout = opts.timeoutMs ?? 5000;
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const has = await ev(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
        if (has) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    },
  };
}

function runCommand(
  cmd: string,
  cmdArgs: string[],
  cwd: string = process.cwd()
): Promise<{ code: number; stdout: string; stderr: string }> {
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

    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("close", (code) => {
      resolve({ code: code ?? 0, stdout, stderr });
    });

    child.on("error", (err) => {
      resolve({ code: 1, stdout, stderr: err.message });
    });
  });
}

function runNpmCommand(
  cmdArgs: string[],
  cwd: string = process.cwd()
): Promise<{ code: number; stdout: string; stderr: string }> {
  return runCommand("npm", cmdArgs, cwd);
}

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
// CLI FLAG & ARGUMENT PARSER FOR `weavetab plugin use`
// ---------------------------------------------------------------------------

function coerceCliValue(val: string): any {
  if (val === "true") return true;
  if (val === "false") return false;
  if (val === "null") return null;
  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
  if ((val.startsWith("{") && val.endsWith("}")) || (val.startsWith("[") && val.endsWith("]"))) {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}

export function parseCliInvokeArgs(rawArgs: string[]): { positional: string[]; flags: Record<string, any> } {
  const positional: string[] = [];
  const flags: Record<string, any> = {};

  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === "--json" && rawArgs[i + 1]) {
      try {
        const parsed = JSON.parse(rawArgs[i + 1]);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          Object.assign(flags, parsed);
        }
      } catch (e: any) {
        throw new Error(`Invalid --json payload: ${e.message}`);
      }
      i++;
      continue;
    }
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx > 2) {
        const k = token.slice(2, eqIdx);
        const v = token.slice(eqIdx + 1);
        flags[k] = coerceCliValue(v);
      } else {
        const k = token.slice(2);
        const next = rawArgs[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[k] = coerceCliValue(next);
          i++;
        } else {
          flags[k] = true;
        }
      }
      continue;
    }
    if (token.startsWith("-") && token.length === 2) {
      const k = token.slice(1);
      const next = rawArgs[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[k] = coerceCliValue(next);
        i++;
      } else {
        flags[k] = true;
      }
      continue;
    }
    positional.push(token);
  }

  return { positional, flags };
}

function validateAgainstPluginSchema(schema: any, input: Record<string, any>): Record<string, any> {
  if (!schema) return input;
  try {
    if (typeof schema.safeParse === "function") {
      const res = schema.safeParse(input);
      if (!res.success) {
        const msg = res.error.issues.map((iss: any) => `${iss.path.join(".") || "arg"}: ${iss.message}`).join("; ");
        throw new Error(msg);
      }
      return res.data;
    }
    if (typeof schema === "object") {
      const values = Object.values(schema);
      const isZodShape = values.some((v: any) => v && typeof v === "object" && "_def" in v);
      if (isZodShape) {
        const zObj = z.object(schema);
        const res = zObj.safeParse(input);
        if (!res.success) {
          const msg = res.error.issues.map((iss: any) => `${iss.path.join(".") || "arg"}: ${iss.message}`).join("; ");
          throw new Error(msg);
        }
        return res.data;
      }
    }
  } catch (err: any) {
    throw new Error(`Invalid arguments: ${err.message}`);
  }
  return input;
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
      console.error(pc.red(`[ERROR] Ambiguous plugin name "${inputName}".`));
      console.error(pc.dim("Multiple packages match on npm:"));
      for (const c of candidates) {
        console.error(`  - ${c.packageName} (${c.label})`);
      }
      console.error(pc.yellow(`\nIn non-interactive environments, specify the package explicitly:`));
      console.error(`  weavetab plugin add ${candidates[0].packageName}`);
      console.error(`  weavetab plugin add ${inputName} --official (or --community)\n`);
      process.exit(1);
    }
  } else if (candidates.length === 1) {
    selectedCandidate = candidates[0];
    selectedPkg = selectedCandidate.packageName;
  }

  const trust = selectedCandidate
    ? {
        tier: selectedCandidate.tier,
        label: selectedCandidate.label,
        badge: selectedCandidate.badge,
        tooltip: selectedCandidate.tooltip,
      }
    : resolvePluginTrust(selectedPkg, verifiedPackages);

  console.log();
  console.log(
    boxen(pc.bold(pc.cyan(" WEAVETAB PLUGIN INSTALL ")), { padding: 0, borderStyle: "round", borderColor: "cyan" })
  );
  console.log();

  if (trust.tier === "official") {
    console.log(`${pc.bgBlue(pc.white(" OFFICIAL "))} ${pc.green(selectedPkg)}`);
    console.log(pc.dim("  Author: Weavetab Core Team"));
    console.log(pc.dim("  Security: Audited and cryptographically trusted first-party package.\n"));
  } else if (trust.tier === "verified") {
    console.log(`${pc.bgGreen(pc.black(" VERIFIED "))} ${pc.green(selectedPkg)}`);
    console.log(pc.dim("  Status: Listed in Weavetab Community Verified Registry."));
    console.log(pc.dim("  Security: Reviewed by Weavetab maintainers.\n"));
  } else {
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
        console.log(
          pc.red("[ERROR] Unverified plugin cannot be installed in non-interactive mode without --yes flag.")
        );
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

  const spinner = ora(`Installing ${pc.cyan(selectedPkg)} via npm...`).start();
  const globalPluginDir = getGlobalPluginDir();
  const installResult = await runNpmCommand(["install", selectedPkg], globalPluginDir);

  if (installResult.code !== 0) {
    spinner.fail(pc.red(`Failed to install ${selectedPkg}`));
    if (installResult.stderr) {
      console.error(pc.dim(installResult.stderr));
    }
    return;
  }

  spinner.succeed(pc.green(`installed ${pc.bold(selectedPkg)}`));

  const targetDir = path.join(globalPluginDir, "node_modules", selectedPkg);
  const installedInfo = inspectInstalledPackage(targetDir);

  if (installedInfo && installedInfo.manifest) {
    const manifest = installedInfo.manifest;
    const tools = manifest.tools || [];
    const commands = manifest.commands || [];
    const prompts = manifest.prompts || [];
    const resources = manifest.resources || [];
    const permissions = normalizePermissions(manifest.permissions);

    const infoLines = [
      `${pc.bold("Plugin Details:")}`,
      `  ${pc.dim("Name:")}        ${manifest.name || selectedPkg}`,
      `  ${pc.dim("Version:")}     ${manifest.version || "1.0.0"}`,
      `  ${pc.dim("Author:")}      ${resolveManifestAuthor(manifest, "Community")}`,
      `  ${pc.dim("Trust Tier:")}  ${trust.badge}`,
      `  ${pc.dim("AGENTS.md:")}   ${installedInfo.agentsMdContent ? pc.green("Bundled (Context-Safe)") : pc.yellow("Missing")}`,
      `  ${pc.dim("Description:")} ${manifest.description || "No description provided"}`,
    ];

    if (commands.length > 0) {
      infoLines.push("", `${pc.bold(`CLI Commands (${commands.length}):`)}`);
      for (const cmd of commands) {
        infoLines.push(
          `  • ${pc.cyan(`weavetab plugin use ${selectedPkg} ${cmd.name}`)}: ${pc.dim(cmd.description || "")}`
        );
      }
    }

    if (tools.length > 0) {
      infoLines.push("", `${pc.bold(`Exposed MCP Tools (${tools.length}):`)}`);
      for (const tool of tools) {
        infoLines.push(`  • ${pc.cyan(tool.name)}: ${pc.dim(tool.description || "")}`);
      }
    }

    if (prompts.length + resources.length > 0) {
      infoLines.push("", `${pc.bold(`Utilities (${prompts.length} prompts, ${resources.length} resources):`)}`);
      for (const pr of prompts) {
        infoLines.push(`  • ${pc.magenta(`/${pr.name}`)}: ${pc.dim(pr.description || "Prompt utility")}`);
      }
      for (const rs of resources) {
        infoLines.push(
          `  • ${pc.magenta(`@${rs.uri || rs.uriTemplate || rs.name}`)}: ${pc.dim(rs.description || "Resource utility")}`
        );
      }
    }

    const permsList: string[] = [];
    if (permissions.commands?.add) permsList.push(`CLI Commands (${permissions.commands.reason || "unspecified"})`);
    if (permissions.network) permsList.push(`Network (${permissions.network.reason || "unspecified"})`);
    if (permissions.cdp) permsList.push(`CDP (${permissions.cdp.reason || "unspecified"})`);
    if (permissions.fs) permsList.push(`FileSystem (${permissions.fs.reason || "unspecified"})`);
    if (permissions.tools?.override?.length) {
      permsList.push(
        `Tool Overrides: [${permissions.tools.override.join(", ")}] (${permissions.tools.reason || "unspecified"})`
      );
    }
    if (permissions.tools?.remove?.length) {
      permsList.push(
        `Tool Removals: [${permissions.tools.remove.join(", ")}] (${permissions.tools.reason || "unspecified"})`
      );
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
    touchPluginEpoch();
    console.log(pc.green("✔ Plugin installed and hot-loaded into active MCP sessions!\n"));
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
  const globalPluginDir = getGlobalPluginDir();
  const installResult = await runNpmCommand(["install", absDir], globalPluginDir);
  if (installResult.code !== 0) {
    spinner.fail(pc.red(`Failed to install ${local.packageName}`));
    if (installResult.stderr) console.error(pc.dim(installResult.stderr));
    return;
  }
  spinner.succeed(pc.green(`installed ${pc.bold(local.packageName)} (local path)`));

  const targetDir = path.join(globalPluginDir, "node_modules", local.packageName);
  const installedInfo = fs.existsSync(targetDir) ? inspectInstalledPackage(targetDir) : local;
  const manifest = (installedInfo?.manifest || local.manifest) as any;
  const tools = manifest.tools || [];
  const commands = manifest.commands || [];
  console.log();
  console.log(
    boxen(
      `${pc.bold("Plugin Details:")}\n` +
        `  ${pc.dim("Name:")}        ${manifest.name || local.packageName}\n` +
        `  ${pc.dim("Version:")}     ${manifest.version || "1.0.0"}\n` +
        `  ${pc.dim("Source:")}      ${absDir} (local path)\n` +
        `  ${pc.dim("Instructions:")} ${installedInfo?.instructions || installedInfo?.agentsMdContent ? pc.green("Declared") : pc.yellow("None")}\n` +
        `  ${pc.dim("Description:")} ${manifest.description || "No description provided"}` +
        (commands.length > 0
          ? `\n\n${pc.bold(`CLI Commands (${commands.length}):`)}` +
            commands
              .map((c: any) => `\n  • ${pc.cyan(`weavetab plugin use ${local.packageName} ${c.name}`)}: ${pc.dim(c.description || "")}`)
              .join("")
          : "") +
        (tools.length > 0
          ? `\n\n${pc.bold(`Exposed Tools (${tools.length}):`)}` +
            tools.map((t: any) => `\n  • ${pc.cyan(t.name)}: ${pc.dim(t.description || "")}`).join("")
          : ""),
      { padding: 1, borderStyle: "round", borderColor: "green" }
    )
  );
  console.log();
  touchPluginEpoch();
  console.log(pc.green("✔ Plugin installed and hot-loaded into active MCP sessions!\n"));
}

// ---------------------------------------------------------------------------
// 2. LIST INSTALLED PLUGINS
// ---------------------------------------------------------------------------

export async function runPluginList(): Promise<void> {
  const verifiedPackages = await getVerifiedPackages();
  const plugins = listInstalledPlugins();

  console.clear();
  console.log(
    boxen(pc.bold(pc.cyan(" INSTALLED WEAVETAB PLUGINS ")), { padding: 0, borderStyle: "round", borderColor: "cyan" })
  );
  console.log();

  if (plugins.length === 0) {
    console.log(pc.dim("No Weavetab plugins found in the local node_modules directory."));
    console.log(
      pc.dim(`Install official or community plugins using: ${pc.cyan("weavetab plugin add <packageName>")}\n`)
    );
    return;
  }

  console.log(pc.dim(`Found ${plugins.length} installed plugin(s):\n`));

  for (const pInfo of plugins) {
    const trust = resolvePluginTrust(pInfo.packageName, verifiedPackages);
    const m = pInfo.manifest;
    const toolCount = m.tools?.length ?? 0;
    const cmdCount = m.commands?.length ?? 0;
    const promptCount = m.prompts?.length ?? 0;
    const resourceCount = m.resources?.length ?? 0;

    console.log(`${trust.badge} ${pc.bold(pc.cyan(pInfo.packageName))} ${pc.dim(`v${m.version || "1.0.0"}`)}`);
    console.log(`  ${pc.dim("Author:")}      ${resolveManifestAuthor(m, "Unknown")}`);
    console.log(`  ${pc.dim("Description:")} ${m.description || "(none)"}`);
    console.log(
      `  ${pc.dim("Capabilities:")} ${toolCount} tool(s), ${cmdCount} CLI command(s), ${promptCount + resourceCount} utilit${promptCount + resourceCount === 1 ? "y" : "ies"} (${promptCount} / prompts, ${resourceCount} @ resources)`
    );
    console.log(
      `  ${pc.dim("Instructions:")} ${pInfo.instructions || pInfo.agentsMdContent ? pc.green(`Declared (view via: weavetab plugin use ${pInfo.packageName} instructions)`) : pc.yellow("None")}`
    );

    if (m.commands && m.commands.length > 0) {
      const cmdNames = m.commands.map((c) => pc.cyan(c.name)).join(", ");
      console.log(`  ${pc.dim("Commands:")}    ${cmdNames}`);
    }
    if (m.tools && m.tools.length > 0) {
      const toolNames = m.tools.map((t) => pc.green(t.name)).join(", ");
      console.log(`  ${pc.dim("Tools:")}       ${toolNames}`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// 3. USE / RUN PLUGIN CLI COMMANDS, TOOLS & AGENTS.MD PLAYBOOK
// ---------------------------------------------------------------------------

export async function runPluginUse(args: string[]): Promise<void> {
  const pkgQuery = args[0];
  if (!pkgQuery || pkgQuery === "--help" || pkgQuery === "-h") {
    console.log();
    console.log(
      boxen(pc.bold(pc.cyan(" WEAVETAB PLUGIN USE ")), { padding: 0, borderStyle: "round", borderColor: "cyan" })
    );
    console.log();
    console.log(pc.bold("USAGE"));
    console.log(`  ${pc.cyan("weavetab plugin use <plugin>")}                        Inspect plugin commands, tools & utilities`);
    console.log(`  ${pc.cyan("weavetab plugin use <plugin> agents")}                 Read the plugin's AGENTS.md playbook`);
    console.log(`  ${pc.cyan("weavetab plugin use <plugin> <command> [--flags]")}    Execute a plugin CLI command`);
    console.log(`  ${pc.cyan("weavetab plugin use <plugin> <tool> [--flags]")}       Execute a plugin MCP tool from the CLI`);
    console.log();
    console.log(pc.bold("EXAMPLES"));
    console.log(`  ${pc.dim("$")} weavetab plugin use github repo-summary --repo weavetab/mcp`);
    console.log(`  ${pc.dim("$")} weavetab plugin use realtime status`);
    console.log(`  ${pc.dim("$")} weavetab plugin use auth profiles`);
    console.log(`  ${pc.dim("$")} weavetab plugin use chaos agents`);
    console.log();
    return;
  }

  const loaded = await loadAndInitPlugin(pkgQuery);
  if (!loaded) {
    console.error(pc.red(`[ERROR] Plugin "${pkgQuery}" is not installed.`));
    console.error(pc.dim(`Install it first with: ${pc.cyan(`weavetab plugin add ${pkgQuery}`)}`));
    process.exit(1);
  }

  const { plugin, info } = loaded;
  const target = args[1];
  const restArgs = args.slice(2);

  // If no target or --help, print overview of commands, tools, utilities, and AGENTS.md pointer
  if (!target || target === "--help" || target === "-h" || target === "help") {
    const cmds = plugin.commands || [];
    const tools = plugin.tools || [];
    const prompts = plugin.prompts || [];
    const resources = plugin.resources || [];

    console.log();
    console.log(
      boxen(
        `${pc.bold(pc.cyan(info.packageName))} ${pc.dim(`v${plugin.version}`)}\n` +
          pc.dim(plugin.description || info.manifest.description || ""),
        { padding: 1, borderStyle: "round", borderColor: "cyan" }
      )
    );
    console.log();

    if (cmds.length > 0) {
      console.log(pc.bold(`CLI COMMANDS (${cmds.length}) — permissions.commands.add = true`));
      for (const c of cmds) {
        console.log(`  ${pc.cyan(`weavetab plugin use ${pkgQuery} ${c.name}`)}`);
        console.log(`    ${pc.dim(c.description || "")}`);
        if (c.usage) console.log(`    ${pc.dim(`Usage: ${c.usage}`)}`);
      }
      console.log();
    } else {
      console.log(pc.dim("No CLI commands registered by this plugin.\n"));
    }

    if (tools.length > 0) {
      console.log(pc.bold(`MCP TOOLS (${tools.length}) — callable via CLI or MCP`));
      for (const t of tools) {
        console.log(`  ${pc.green(`weavetab plugin use ${pkgQuery} ${t.name}`)} — ${pc.dim(t.description || "")}`);
      }
      console.log();
    }

    if (prompts.length + resources.length > 0) {
      console.log(
        pc.bold(`UTILITIES (${prompts.length} / Prompts, ${resources.length} @ Resources)`)
      );
      for (const pr of prompts) {
        console.log(`  ${pc.magenta(`/${pr.name}`)} (Prompt) — ${pc.dim(pr.description || "")}`);
      }
      for (const rs of resources) {
        console.log(
          `  ${pc.magenta(`@${rs.uri || rs.uriTemplate || rs.name}`)} (Resource) — ${pc.dim(rs.description || "")}`
        );
      }
      console.log();
    }

    const agentText = plugin.instructions || plugin.agentsMdContent;
    if (agentText) {
      console.log(
        pc.dim(`Agent Instructions: run `) +
          pc.cyan(`weavetab plugin use ${pkgQuery} instructions`) +
          pc.dim(` to print full instructions.\n`)
      );
    }
    return;
  }

  // `weavetab plugin use <pkg> instructions` (or `agents` alias) -> print instructions
  if (target === "instructions" || target === "--instructions" || target === "agents" || target === "agents.md" || target === "--agents") {
    const text = plugin.instructions || plugin.agentsMdContent;
    if (!text) {
      console.error(pc.yellow(`[WARN] Plugin "${info.packageName}" does not provide instructions.`));
      process.exit(1);
    }
    console.log(text);
    return;
  }

  const { positional, flags } = parseCliInvokeArgs(restArgs);
  const pluginCtx = (plugin as any)._context;
  const perms = normalizePermissions(plugin.permissions || info.manifest.permissions);

  // 1. Match against registered CLI Commands (`plugin.commands`)
  const matchedCmd = (plugin.commands || []).find((c) => c.name === target);
  if (matchedCmd) {
    if (!perms.commands?.add) {
      console.error(
        pc.red(
          `[PERMISSION DENIED] Plugin "${info.packageName}" attempted to run CLI command "${target}" without 'permissions.commands.add: true' in weavetab.json.`
        )
      );
      process.exit(1);
    }

    const validatedFlags = validateAgainstPluginSchema(matchedCmd.schema, flags);

    let session: any = undefined;
    let tabClient: any = undefined;
    if (matchedCmd.requiresSession) {
      const { loadConfig } = await import("../config/loader.js");
      const { getOrConnect } = await import("../cdp/connector.js");
      const cfg = await loadConfig();
      session = (await getOrConnect(cfg)) as any;
      const ev = async (expression: string) => (await session.Runtime.evaluate({ expression, returnByValue: true })).result?.value;
      tabClient = createCliTabProxy(session);
    }

    const cmdCtx = {
      args: positional,
      flags: validatedFlags,
      tab: tabClient,
      desktop: pluginCtx.desktop,
      storage: pluginCtx.storage,
      config: pluginCtx.config,
      logger: pluginCtx.logger,
      session,
    };

    const output = await matchedCmd.handler(validatedFlags, cmdCtx);
    if (typeof output === "string") {
      console.log(output);
    } else if (output !== undefined) {
      console.log(JSON.stringify(output, null, 2));
    }
    return;
  }

  // 2. Match against registered MCP Tools (`plugin.tools`)
  const matchedTool = (plugin.tools || []).find((t) => t.name === target);
  if (matchedTool) {
    if (!perms.tools?.add) {
      console.error(
        pc.red(
          `[PERMISSION DENIED] Plugin "${info.packageName}" cannot run tool "${target}" without 'permissions.tools.add: true'.`
        )
      );
      process.exit(1);
    }

    const validatedArgs = validateAgainstPluginSchema((matchedTool as any).schema, flags);

    let session: any = undefined;
    let tabClient: any = undefined;
    if (matchedTool.requiresSession !== false) {
      try {
        const { loadConfig } = await import("../config/loader.js");
        const { getOrConnect } = await import("../cdp/connector.js");
        const cfg = await loadConfig();
        session = (await getOrConnect(cfg)) as any;
      const ev = async (expression: string) => (await session.Runtime.evaluate({ expression, returnByValue: true })).result?.value;
      tabClient = createCliTabProxy(session);
      } catch {
        // Allow API-capable tools to still run or report their own session error
      }
    }

    const toolCtx = {
      tab: tabClient,
      desktop: pluginCtx.desktop,
      storage: pluginCtx.storage,
      config: pluginCtx.config,
      logger: pluginCtx.logger,
      session,
    };

    const callCtx = session ? Object.assign(Object.create(session), toolCtx) : toolCtx;
    const res =
      matchedTool.handler.length <= 2
        ? await matchedTool.handler(validatedArgs, callCtx)
        : await matchedTool.handler(validatedArgs, session, pluginCtx.config);

    if (typeof res === "string") {
      console.log(res);
    } else if (res && Array.isArray(res.content)) {
      for (const item of res.content) {
        if (item.type === "text" && typeof item.text === "string") {
          console.log(item.text);
        } else {
          console.log(JSON.stringify(item, null, 2));
        }
      }
      if (res.isError) process.exit(1);
    } else if (res !== undefined) {
      console.log(JSON.stringify(res, null, 2));
    }
    return;
  }

  // 3. Match against Prompt Utilities (`/prompt`) or Resource Utilities (`@uri`)
  const cleanPromptName = target.startsWith("/") ? target.slice(1) : target;
  const matchedPrompt = (plugin.prompts || []).find((pr) => pr.name === cleanPromptName);
  if (matchedPrompt) {
    const strFlags: Record<string, string> = {};
    for (const [k, v] of Object.entries(flags)) strFlags[k] = String(v);
    const out = await matchedPrompt.handler(strFlags, {
      storage: pluginCtx.storage,
      config: pluginCtx.config,
      logger: pluginCtx.logger,
    });
    console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
    return;
  }

  const cleanResName = target.startsWith("@") ? target.slice(1) : target;
  const matchedRes = (plugin.resources || []).find(
    (r) => r.name === cleanResName || r.uri === cleanResName || r.uriTemplate === cleanResName
  );
  if (matchedRes) {
    const uri = matchedRes.uri || cleanResName;
    const out = await matchedRes.read(uri, flags as any, {
      storage: pluginCtx.storage,
      config: pluginCtx.config,
      logger: pluginCtx.logger,
    });
    console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
    return;
  }

  console.error(
    pc.red(
      `[ERROR] Target "${target}" not found in plugin "${info.packageName}".`
    )
  );
  const availableCmds = (plugin.commands || []).map((c) => c.name);
  const availableTools = (plugin.tools || []).map((t) => t.name);
  if (availableCmds.length > 0) {
    console.error(pc.dim(`Available CLI commands: ${availableCmds.join(", ")}`));
  }
  if (availableTools.length > 0) {
    console.error(pc.dim(`Available MCP tools:    ${availableTools.join(", ")}`));
  }
  process.exit(1);
}

export async function runPluginAgents(pkgQuery?: string): Promise<void> {
  if (pkgQuery) {
    await runPluginUse([pkgQuery, "instructions"]);
    return;
  }

  const installed = listInstalledPlugins();
  if (installed.length === 0) {
    console.log(pc.dim("No plugins installed."));
    return;
  }

  for (const pInfo of installed) {
    console.log(boxen(pc.bold(pc.cyan(`${pInfo.packageName} — Instructions`)), { padding: 0, borderStyle: "round", borderColor: "cyan" }));
    const text = pInfo.instructions || pInfo.agentsMdContent;
    if (text) {
      console.log(text);
    } else {
      console.log(pc.dim("(No instructions declared)"));
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// 4. SEARCH PLUGINS (OFFICIAL & VERIFIED REGISTRY + NPM)
// ---------------------------------------------------------------------------

export async function runPluginSearch(query?: string): Promise<void> {
  const q = (query || "").toLowerCase().trim();
  const spinner = ora(`Searching Weavetab plugin registry for "${pc.cyan(q || "*")}"...`).start();

  const verifiedPackages = await getVerifiedPackages();
  const results: Array<{ name: string; tier: string; badge: string; description: string; author: string }> = [];

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
  } catch {
    /* offline / network error */
  }

  spinner.stop();

  console.log();
  console.log(
    boxen(pc.bold(pc.cyan(` PLUGIN SEARCH RESULTS: "${q || "all"}" `)), {
      padding: 0,
      borderStyle: "round",
      borderColor: "cyan",
    })
  );
  console.log();

  if (results.length === 0) {
    console.log(pc.yellow(`No plugins matching "${q}" found.`));
    console.log(pc.dim(`Try browsing the registry or visit ${pc.cyan("https://weavetab.dev/discover")}\n`));
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
// 5. BROWSE & ONE-CLICK INSTALL (TERMINAL MARKETPLACE)
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
      hint: isInstalled
        ? "Already installed. Select to reinstall or inspect."
        : "Verified community plugin. Press Enter to install.",
    });
  }

  spinner.stop(`Found ${items.length} verified plugin(s) in registry.`);

  if (items.length === 0) {
    p.note("No plugins currently in registry.", "Weavetab Plugins");
    return;
  }

  items.push({
    value: "__search__",
    label: `${pc.cyan("Search for community plugins on npm...")}`,
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
// 6. REMOVE / UNINSTALL PLUGIN
// ---------------------------------------------------------------------------

export async function runPluginRemove(pkgName: string): Promise<void> {
  if (!pkgName || pkgName.startsWith("-")) {
    console.log(pc.red("[ERROR] Please specify the package name to remove."));
    console.log(pc.dim("Usage: weavetab plugin remove <packageName>"));
    return;
  }

  const spinner = ora(`Uninstalling ${pc.cyan(pkgName)} via npm...`).start();
  const globalPluginDir = getGlobalPluginDir();
  const result = await runNpmCommand(["uninstall", pkgName], globalPluginDir);

  if (result.code !== 0) {
    spinner.fail(pc.red(`Failed to remove ${pkgName}`));
    if (result.stderr) console.error(pc.dim(result.stderr));
    return;
  }

  spinner.succeed(pc.green(`removed ${pc.bold(pkgName)}`));
  touchPluginEpoch();
  console.log(pc.dim("The plugin and its tools have been uninstalled.\n"));
}

// ---------------------------------------------------------------------------
// 7. VERIFY / CHECK PLUGIN TRUST & AGENTS.MD COMPLIANCE
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

  const localInfo = resolveInstalledPluginInfo(pkgName);
  const resolvedName = localInfo?.packageName || pkgName;
  const trust = resolvePluginTrust(resolvedName, verifiedPackages);

  console.log();
  console.log(
    boxen(pc.bold(pc.cyan(` PLUGIN TRUST REPORT: ${resolvedName} `)), {
      padding: 0,
      borderStyle: "round",
      borderColor: "cyan",
    })
  );
  console.log();
  console.log(`  ${pc.dim("Package:")}    ${pc.bold(resolvedName)}`);
  console.log(`  ${pc.dim("Tier:")}       ${trust.badge} (${trust.label})`);
  console.log(`  ${pc.dim("Details:")}    ${trust.tooltip}`);
  if (localInfo) {
    const text = localInfo.instructions || localInfo.agentsMdContent;
    const hasInstructions = Boolean(text);
    const chars = text ? text.length : 0;
    console.log(
      `  ${pc.dim("Instructions:")} ${hasInstructions ? pc.green(`Compliant (${chars}/${MAX_AGENTS_MD_CHARS} chars)`) : pc.yellow("None declared")}`
    );
  }
  console.log();

  if (trust.tier === "unverified") {
    console.log(pc.yellow("  Want to get this package verified?"));
    console.log(pc.dim(`  Submit a verification PR to the registry at: ${pc.cyan(REGISTRY_URL)}\n`));
  }
}

// ---------------------------------------------------------------------------
// 8. MAIN CLI ROUTER FOR PLUGINS (User / Operations Mode)
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
    console.log(
      boxen(pc.bold(pc.cyan(" WEAVETAB PLUGIN MANAGER ")), { padding: 0, borderStyle: "round", borderColor: "cyan" })
    );
    console.log();
    console.log(pc.bold("USAGE"));
    console.log(`  weavetab plugin <command> [options]`);
    console.log();
    console.log(pc.bold("COMMANDS"));
    console.log(
      `  ${pc.cyan("use <pkg> [cmd]")}     Execute a plugin CLI command, MCP tool, or read its AGENTS.md playbook`
    );
    console.log(
      `  ${pc.cyan("agents [pkg]")}        Print the context-safe AGENTS.md guide for one or all installed plugins`
    );
    console.log(
      `  ${pc.cyan("add <pkg|path>")}      Install a plugin by npm name or local path (e.g. @acme/weavetab-plugin, ./my-plugin)`
    );
    console.log(`  ${pc.cyan("browse")}              Interactive terminal explorer to browse & 1-click install`);
    console.log(`  ${pc.cyan("search [query]")}      Search plugins across official registry & npm`);
    console.log(`  ${pc.cyan("list")}                List all installed plugins, CLI commands, tools, and utilities`);
    console.log(`  ${pc.cyan("remove <pkg>")}        Uninstall a plugin from local environment`);
    console.log(`  ${pc.cyan("verify <pkg>")}        Check trust tier, registry status, and AGENTS.md compliance`);
    console.log();
    console.log(pc.bold("DEVELOPER SDK (@weavetab/sdk)"));
    console.log(`  ${pc.dim("Scaffold a plugin:")}  ${pc.cyan("npx @weavetab/sdk init <name>")}`);
    console.log(`  ${pc.dim("Build & validate:")}   ${pc.cyan("npx @weavetab/sdk build")}`);
    console.log();
    console.log(pc.bold("OPTIONS (for 'add' / general)"));
    console.log(`  ${pc.cyan("--refresh")}           Invalidate and refresh the verified plugin cache`);
    console.log(`  ${pc.cyan("--official, -O")}      Prefer official @weavetab/plugin-<name>`);
    console.log(`  ${pc.cyan("--community, -C")}     Prefer community package`);
    console.log(`  ${pc.cyan("--yes, -y")}           Bypass interactive warning prompt for unverified plugins`);
    console.log();
    return;
  }

  if (subcmd === "init" || subcmd === "create" || subcmd === "new" || subcmd === "build" || subcmd === "manifest") {
    console.log(pc.yellow(`\n[Weavetab] Plugin authoring commands belong to the developer SDK (@weavetab/sdk).`));
    console.log(pc.dim("To scaffold a new plugin:   ") + pc.cyan("npx @weavetab/sdk init <name>"));
    console.log(pc.dim("To build/validate a plugin: ") + pc.cyan("npx @weavetab/sdk build"));
    console.log(pc.dim("SDK documentation:          ") + pc.cyan("https://weavetab.dev/docs/sdk-overview\n"));
    return;
  }

  if (subcmd === "use" || subcmd === "run" || subcmd === "exec") {
    await runPluginUse(cleanArgs.slice(1));
    return;
  }

  if (subcmd === "agents" || subcmd === "guide") {
    await runPluginAgents(cleanArgs[1]);
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
    await runPluginRemove(cleanArgs[1]);
    return;
  }

  if (subcmd === "verify" || subcmd === "check") {
    await runPluginVerify(cleanArgs[1]);
    return;
  }

  console.log(pc.red(`[ERROR] Unknown plugin subcommand: "${subcmd}"`));
  console.log(pc.dim("Run 'weavetab plugin --help' to see available commands."));
}
