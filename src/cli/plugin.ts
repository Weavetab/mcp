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
  encodeNpmPackageName,
  stripNpmVersion,
  REGISTRY_URL,
  type PluginCandidate,
} from "../plugin/registry.js";
import {
  listInstalledPlugins,
  inspectInstalledPackage,
  normalizePermissions,
  tryLoadPluginAsync,
  resolveInstalledPluginInfo,
  getDisabledPlugins,
  isPluginDisabled,
  setPluginEnabled,
  touchPluginEpoch,
  MAX_INSTRUCTIONS_LINES,
  MAX_INSTRUCTIONS_CHARS,
} from "../plugin/loader.js";
import { toPluginInputShape } from "../plugin/schema.js";

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
  const ev = async (expression: string) => {
    const res = await session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || "eval failed");
    }
    return res?.result?.value;
  };
  return {
    session,
    isAvailable: () => true,
    url: async () => String((await ev("location.href").catch(() => "")) || ""),
    title: async () => String((await ev("document.title").catch(() => "")) || ""),
    evaluate: async (fn: any, ...a: any[]) => ev(typeof fn === "function" ? `(${fn})(${a.map((x: any) => JSON.stringify(x)).join(",")})` : fn),
    extract: async (selector: string, mode: "text" | "html" | "value" = "text") => {
      const expr = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        if (${JSON.stringify(mode)} === "html") return el.outerHTML;
        if (${JSON.stringify(mode)} === "value" && "value" in el) return String(el.value);
        return el.textContent?.trim() || "";
      })()`;
      return (await ev(expr).catch(() => null)) ?? null;
    },
    waitForSelector: async (selector: string, opts: any = {}) => {
      const timeout = opts.timeoutMs ?? 5000;
      const checkVis = Boolean(opts.visible);
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const has = await ev(`(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return false;
          if (!${checkVis}) return true;
          return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        })()`).catch(() => false);
        if (has) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    },
  };
}

const NPM_PKG_NAME_REGEX = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-zA-Z0-9._-]+)?$/;

export function isValidNpmPackageSpec(spec: string): boolean {
  if (!spec || typeof spec !== "string" || spec.includes("..")) return false;
  return NPM_PKG_NAME_REGEX.test(spec.trim());
}

function resolveNpmCliJs(): string | null {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c) && c.endsWith(".js")) return c;
  }
  return null;
}

function runCommand(
  cmd: string,
  cmdArgs: string[],
  cwd: string = process.cwd()
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const npmCli = cmd === "npm" ? resolveNpmCliJs() : null;
    const isWin = process.platform === "win32";
    const usesCmdShell = !npmCli && isWin;

    for (const arg of cmdArgs) {
      if (/[\r\n\0]/.test(arg) || (usesCmdShell && /[&|;<>^%`]/.test(arg))) {
        resolve({ code: 1, stdout: "", stderr: "Rejected unsafe characters in command arguments." });
        return;
      }
    }

    const child = npmCli
      ? spawn(process.execPath, [npmCli, ...cmdArgs], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        })
      : isWin
      ? spawn("cmd.exe", ["/d", "/s", "/c", cmd.endsWith(".cmd") || cmd.endsWith(".exe") ? cmd : `${cmd}.cmd`, ...cmdArgs], {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          windowsVerbatimArguments: false,
        })
      : spawn(cmd, cmdArgs, {
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
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

function resolveManifestAuthor(manifest: any, pkgJson: any, fallback: string): string {
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

  return (
    pick(pkgJson?.author) ||
    pick(pkgJson?.contributors) ||
    pick(manifest?.author) ||
    pick(manifest?.authors) ||
    fallback
  );
}

function parseSemverTuple(ver: string): [number, number, number, string] {
  const cleaned = String(ver || "0.0.0").trim().replace(/^v/i, "");
  const [core, prerelease = ""] = cleaned.split("-", 2);
  const parts = core.split(".").map((n) => parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0, prerelease];
}

export function compareSemver(a: string, b: string): number {
  const [majA, minA, patA, preA] = parseSemverTuple(a);
  const [majB, minB, patB, preB] = parseSemverTuple(b);
  if (majA !== majB) return majA - majB;
  if (minA !== minB) return minA - minB;
  if (patA !== patB) return patA - patB;
  if (!preA && preB) return 1;
  if (preA && !preB) return -1;
  return preA.localeCompare(preB);
}

function formatPluginInstructionsOutput(
  pkgName: string,
  version: string,
  instructions?: string,
  commands?: Array<{ name: string; description: string; usage?: string; parameters?: Record<string, any> }>
): string {
  const sections: string[] = [];
  sections.push(`# ${pkgName} (v${version}) — Operational Instructions`);

  if (instructions && instructions.trim()) {
    sections.push(instructions.trim());
  }

  if (commands && commands.length > 0) {
    const cmdLines: string[] = ["## CLI Commands"];
    for (const cmd of commands) {
      const usage = cmd.usage || `weavetab plugin use ${pkgName} ${cmd.name}`;
      cmdLines.push(`- \`${usage}\` — ${cmd.description}`);
      if (cmd.parameters && Object.keys(cmd.parameters).length > 0) {
        for (const [flagName, meta] of Object.entries(cmd.parameters)) {
          const req = meta?.required ? "required" : "optional";
          const type = meta?.type || "string";
          const desc = meta?.description ? ` — ${meta.description}` : "";
          cmdLines.push(`    --${flagName} (${type}, ${req})${desc}`);
        }
      }
    }
    sections.push(cmdLines.join("\n"));
  }

  return sections.join("\n\n");
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

const FORBIDDEN_FLAG_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isFlagValueToken(tok: string | undefined): tok is string {
  if (tok === undefined) return false;
  return !tok.startsWith("-") || /^-\d+(\.\d+)?$/.test(tok);
}

export function parseCliInvokeArgs(rawArgs: string[]): { positional: string[]; flags: Record<string, any> } {
  const positional: string[] = [];
  const flags: Record<string, any> = {};

  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i];
    if (token === "--json") {
      if (rawArgs[i + 1] === undefined) {
        throw new Error("Missing JSON value after --json");
      }
      try {
        const parsed = JSON.parse(rawArgs[i + 1]);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [k, v] of Object.entries(parsed)) {
            if (FORBIDDEN_FLAG_KEYS.has(k)) continue;
            flags[k] = v;
          }
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
        if (FORBIDDEN_FLAG_KEYS.has(k)) continue;
        flags[k] = coerceCliValue(token.slice(eqIdx + 1));
      } else {
        const k = token.slice(2);
        const next = rawArgs[i + 1];
        if (!k || FORBIDDEN_FLAG_KEYS.has(k)) {
          if (isFlagValueToken(next)) i++;
          continue;
        }
        if (isFlagValueToken(next)) {
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
      if (isFlagValueToken(next)) {
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
      const shape = toPluginInputShape(schema);
      if (Object.keys(shape).length > 0) {
        const res = z.object(shape).safeParse(input);
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
    console.error(pc.red("[ERROR] Please provide a package name or local path to install."));
    console.error(pc.dim("Usage: weavetab plugin add <packageName|./local-path> [--official | --community] [--yes]"));
    process.exitCode = 1;
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

  if (!isValidNpmPackageSpec(inputName)) {
    console.error(pc.red(`[ERROR] Invalid npm package name: "${inputName}"`));
    process.exitCode = 1;
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

  const selectedPkgBase = stripNpmVersion(selectedPkg).name;
  const trust = selectedCandidate
    ? {
        tier: selectedCandidate.tier,
        label: selectedCandidate.label,
        badge: selectedCandidate.badge,
        tooltip: selectedCandidate.tooltip,
      }
    : resolvePluginTrust(selectedPkgBase, verifiedPackages);

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
        console.error(
          pc.red("[ERROR] Unverified plugin cannot be installed in non-interactive mode without --yes flag.")
        );
        process.exitCode = 1;
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

  if (!isValidNpmPackageSpec(selectedPkg)) {
    console.error(pc.red(`[ERROR] Invalid package name: "${selectedPkg}"`));
    process.exitCode = 1;
    return;
  }

  const spinner = ora(`Installing ${pc.cyan(selectedPkg)} via npm...`).start();
  const globalPluginDir = getGlobalPluginDir();
  const installResult = await runNpmCommand(["install", "--ignore-scripts", selectedPkg], globalPluginDir);

  if (installResult.code !== 0) {
    spinner.fail(pc.red(`Failed to install ${selectedPkg}`));
    if (installResult.stderr) {
      console.error(pc.dim(installResult.stderr));
    }
    process.exitCode = 1;
    return;
  }

  spinner.succeed(pc.green(`installed ${pc.bold(selectedPkg)}`));

  const targetDir = path.join(globalPluginDir, "node_modules", selectedPkgBase);
  const installedInfo = inspectInstalledPackage(targetDir);

  if (installedInfo && installedInfo.manifest) {
    const manifest = installedInfo.manifest;
    const pkgJson = installedInfo.pkgJson;
    const tools = manifest.tools || [];
    const commands = manifest.commands || [];
    const prompts = manifest.prompts || [];
    const resources = manifest.resources || [];
    const permissions = normalizePermissions(manifest.permissions);
    const resolvedVersion = pkgJson?.version || manifest.version || "1.0.0";

    const infoLines = [
      `${pc.bold("Plugin Details:")}`,
      `  ${pc.dim("Package:")}      ${selectedPkg}`,
      `  ${pc.dim("Name:")}         ${manifest.displayName || manifest.name || selectedPkg}`,
      `  ${pc.dim("Version:")}      ${resolvedVersion}`,
      `  ${pc.dim("Author:")}       ${resolveManifestAuthor(manifest, pkgJson, "Community")}`,
      `  ${pc.dim("Trust Tier:")}   ${trust.badge}`,
      `  ${pc.dim("Instructions:")} ${installedInfo.instructions ? pc.green("Bundled (Context-Safe)") : pc.dim("None")}`,
      `  ${pc.dim("Description:")}  ${manifest.description || "No description provided"}`,
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

    if (prompts.length > 0) {
      infoLines.push("", `${pc.bold(`Prompts (${prompts.length}):`)}`);
      for (const pr of prompts) {
        infoLines.push(`  • ${pc.magenta(`/${pr.name}`)}: ${pc.dim(pr.description || "Prompt")}`);
      }
    }

    if (resources.length > 0) {
      infoLines.push("", `${pc.bold(`Resources (${resources.length}):`)}`);
      for (const rs of resources) {
        infoLines.push(
          `  • ${pc.magenta(`@${rs.uri || rs.uriTemplate || rs.name}`)}: ${pc.dim(rs.description || "Resource")}`
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
    console.error(pc.red(`[ERROR] Local path not found: ${inputPath}`));
    process.exitCode = 1;
    return;
  }
  const local = inspectInstalledPackage(absDir);
  if (!local) {
    console.error(pc.red(`[ERROR] No valid weavetab.json manifest in ${absDir}`));
    console.error(pc.dim("Scaffold one with: npx @weavetab/sdk init <name>"));
    process.exitCode = 1;
    return;
  }
  if (!isValidNpmPackageSpec(local.packageName) || local.packageName.includes("..")) {
    console.error(pc.red(`[ERROR] Unsafe package name "${local.packageName}" in local plugin.`));
    process.exitCode = 1;
    return;
  }

  const spinner = ora(`Installing local plugin ${pc.cyan(local.packageName)} from ${pc.dim(absDir)} via npm...`).start();
  const globalPluginDir = getGlobalPluginDir();
  const installResult = await runNpmCommand(["install", "--ignore-scripts", absDir], globalPluginDir);
  if (installResult.code !== 0) {
    spinner.fail(pc.red(`Failed to install ${local.packageName}`));
    if (installResult.stderr) console.error(pc.dim(installResult.stderr));
    process.exitCode = 1;
    return;
  }
  spinner.succeed(pc.green(`installed ${pc.bold(local.packageName)} (local path)`));

  const targetDir = path.join(globalPluginDir, "node_modules", local.packageName);
  const installedInfo = fs.existsSync(targetDir) ? inspectInstalledPackage(targetDir) : local;
  const manifest = (installedInfo?.manifest || local.manifest) as any;
  const pkgJson = installedInfo?.pkgJson || local.pkgJson;
  const tools = manifest.tools || [];
  const commands = manifest.commands || [];
  const resolvedVersion = pkgJson?.version || manifest.version || "1.0.0";
  console.log();
  console.log(
    boxen(
      `${pc.bold("Plugin Details:")}\n` +
        `  ${pc.dim("Package:")}      ${local.packageName}\n` +
        `  ${pc.dim("Name:")}         ${manifest.displayName || manifest.name || local.packageName}\n` +
        `  ${pc.dim("Version:")}      ${resolvedVersion}\n` +
        `  ${pc.dim("Source:")}       ${absDir} (local path)\n` +
        `  ${pc.dim("Instructions:")} ${installedInfo?.instructions ? pc.green("Declared") : pc.dim("None")}\n` +
        `  ${pc.dim("Description:")}  ${manifest.description || "No description provided"}` +
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
// 1c. UPDATE / UPGRADE INSTALLED PLUGIN (`weavetab plugin update <name>`)
// ---------------------------------------------------------------------------

export async function runPluginUpdate(inputName?: string, args: string[] = []): Promise<void> {
  if (!inputName || inputName.startsWith("-")) {
    console.error(pc.red("[ERROR] Please specify an installed plugin name to update."));
    console.error(pc.dim("Usage: weavetab plugin update <packageName> [--latest | --version <x.y.z>]"));
    process.exitCode = 1;
    return;
  }

  const globalPluginDir = getGlobalPluginDir();
  const globalPkgJsonPath = path.join(globalPluginDir, "package.json");
  let globalDeps: Record<string, string> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(globalPkgJsonPath, "utf8"));
    globalDeps = raw?.dependencies || {};
  } catch {
    globalDeps = {};
  }

  const localInfo = resolveInstalledPluginInfo(inputName);
  const resolvedPkg = localInfo?.packageName;
  const isInstalledInGlobal =
    resolvedPkg &&
    (Object.prototype.hasOwnProperty.call(globalDeps, resolvedPkg) ||
      fs.existsSync(path.join(globalPluginDir, "node_modules", resolvedPkg, "package.json")));

  if (!localInfo || !resolvedPkg || !isInstalledInGlobal) {
    console.error(pc.red(`[ERROR] Plugin "${inputName}" does not exist in your environment.`));
    console.error(pc.dim(`Install it first using: ${pc.cyan(`weavetab plugin add ${inputName}`)}\n`));
    process.exitCode = 1;
    return;
  }

  const currentVersion = localInfo.pkgJson?.version || localInfo.manifest?.version || "0.0.0";
  const verifiedPackages = await getVerifiedPackages();
  const trust = resolvePluginTrust(resolvedPkg, verifiedPackages, localInfo.dir);

  const spinner = ora(`Checking npm registry for newer versions of ${pc.cyan(resolvedPkg)}...`).start();
  let registryMeta: any = null;
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeNpmPackageName(resolvedPkg)}`, {
      signal: AbortSignal.timeout(6000),
      headers: { "User-Agent": `Weavetab/${getVersion()}` },
    });
    if (!res.ok) {
      spinner.fail(pc.red(`Failed to fetch registry metadata for ${resolvedPkg} (HTTP ${res.status}).`));
      process.exitCode = 1;
      return;
    }
    registryMeta = await res.json();
  } catch (err: any) {
    spinner.fail(pc.red(`Failed to reach npm registry: ${err?.message || String(err)}`));
    process.exitCode = 1;
    return;
  }
  spinner.stop();

  const allVersions = Object.keys(registryMeta?.versions || {});
  const timeMap: Record<string, string> = registryMeta?.time || {};
  const latestDistTag: string | undefined = registryMeta?.["dist-tags"]?.latest;

  const newerVersions = allVersions
    .filter((v) => compareSemver(v, currentVersion) > 0)
    .sort((a, b) => compareSemver(b, a));

  console.log();
  console.log(
    boxen(
      `${pc.bold(pc.cyan(" WEAVETAB PLUGIN UPDATE "))}\n\n` +
        `  ${pc.dim("Package:")}          ${pc.bold(resolvedPkg)}\n` +
        `  ${pc.dim("Current Version:")}  ${pc.yellow(`v${currentVersion}`)}\n` +
        `  ${pc.dim("Trust Tier:")}       ${trust.badge}`,
      { padding: 1, borderStyle: "round", borderColor: "cyan" }
    )
  );
  console.log();

  if (newerVersions.length === 0) {
    console.log(pc.green(`✔ ${pc.bold(resolvedPkg)} is already on the latest version (v${currentVersion}).\n`));
    return;
  }

  let targetVersion: string | undefined;
  const verFlagIdx = args.findIndex((a) => a === "--version" || a === "-v");
  if (verFlagIdx !== -1 && args[verFlagIdx + 1]) {
    const requested = args[verFlagIdx + 1].replace(/^v/i, "");
    if (!newerVersions.includes(requested)) {
      console.error(
        pc.red(
          `[ERROR] Version "${requested}" is not a newer published version of ${resolvedPkg}. Available newer versions: ${newerVersions.join(", ")}`
        )
      );
      process.exit(1);
    }
    targetVersion = requested;
  } else if (args.includes("--latest") || args.includes("-y") || args.includes("--yes")) {
    targetVersion =
      latestDistTag && newerVersions.includes(latestDistTag) ? latestDistTag : newerVersions[0];
  } else if (process.stdin.isTTY) {
    const selected = await p.select({
      message: `Select a newer version of ${resolvedPkg} to upgrade to (current: v${currentVersion}):`,
      options: newerVersions.map((ver) => {
        const iso = timeMap[ver];
        const dateStr = iso ? new Date(iso).toISOString().slice(0, 10) : "unknown date";
        const isLatest = ver === latestDistTag;
        const latestBadge = isLatest ? pc.green(" (latest)") : "";
        return {
          value: ver,
          label: `v${ver}${latestBadge}`,
          hint: `released ${dateStr} • ${trust.label}`,
        };
      }),
    });

    if (p.isCancel(selected)) {
      p.cancel("Update cancelled.");
      return;
    }
    targetVersion = selected as string;
  } else {
    targetVersion =
      latestDistTag && newerVersions.includes(latestDistTag) ? latestDistTag : newerVersions[0];
  }

  const installSpinner = ora(
    `Upgrading ${pc.cyan(resolvedPkg)} from ${pc.yellow(`v${currentVersion}`)} to ${pc.green(`v${targetVersion}`)}...`
  ).start();

  const installResult = await runNpmCommand(
    ["install", "--ignore-scripts", `${resolvedPkg}@${targetVersion}`, "--save-exact"],
    globalPluginDir
  );

  if (installResult.code !== 0) {
    installSpinner.fail(pc.red(`Failed to update ${resolvedPkg} to v${targetVersion}`));
    if (installResult.stderr) console.error(pc.dim(installResult.stderr));
    process.exitCode = 1;
    return;
  }

  installSpinner.succeed(
    pc.green(`Upgraded ${pc.bold(resolvedPkg)} from v${currentVersion} → ${pc.bold(`v${targetVersion}`)}`)
  );
  touchPluginEpoch();
  console.log(pc.green("✔ Updated plugin hot-reloaded into active MCP sessions!\n"));
}

export async function runPluginList(): Promise<void> {
  const verifiedPackages = await getVerifiedPackages();
  const plugins = listInstalledPlugins();
  const disabled = getDisabledPlugins();

  if (process.stdout.isTTY) console.clear();
  console.log(
    boxen(pc.bold(pc.cyan(" INSTALLED WEAVETAB PLUGINS ")), { padding: 0, borderStyle: "round", borderColor: "cyan" })
  );
  console.log();

  if (plugins.length === 0) {
    console.log(pc.dim("No Weavetab plugins installed."));
    console.log(
      pc.dim(`Install official or community plugins using: ${pc.cyan("weavetab plugin add <packageName>")}\n`)
    );
    return;
  }

  console.log(pc.dim(`Found ${plugins.length} installed plugin(s):\n`));

  for (const pInfo of plugins) {
    const trust = resolvePluginTrust(pInfo.packageName, verifiedPackages, pInfo.dir);
    const isOff = disabled.has(pInfo.packageName);
    const m = pInfo.manifest;
    const pkgJson = pInfo.pkgJson;
    const toolCount = m.tools?.length ?? 0;
    const cmdCount = m.commands?.length ?? 0;
    const promptCount = m.prompts?.length ?? 0;
    const resourceCount = m.resources?.length ?? 0;
    const version = pkgJson?.version || m.version || "1.0.0";
    const statusTag = isOff ? pc.yellow(" [Disabled]") : "";

    console.log(`${trust.badge} ${pc.bold(pc.cyan(pInfo.packageName))} ${pc.dim(`v${version}`)}${statusTag}`);
    console.log(`  ${pc.dim("Author:")}       ${resolveManifestAuthor(m, pkgJson, "Unknown")}`);
    console.log(`  ${pc.dim("Description:")}  ${m.description || "(none)"}`);
    console.log(
      `  ${pc.dim("Capabilities:")} ${toolCount} tool(s), ${cmdCount} CLI command(s), ${promptCount} prompt(s), ${resourceCount} resource(s)`
    );
    console.log(
      `  ${pc.dim("Instructions:")} ${pInfo.instructions || cmdCount > 0 ? pc.green(`Declared (view via: weavetab plugin use ${pInfo.packageName} instructions)`) : pc.dim("None")}`
    );

    if (m.commands && m.commands.length > 0) {
      const cmdNames = m.commands.map((c) => pc.cyan(c.name)).join(", ");
      console.log(`  ${pc.dim("Commands:")}     ${cmdNames}`);
    }
    if (m.tools && m.tools.length > 0) {
      const toolNames = m.tools.map((t) => pc.green(t.name)).join(", ");
      console.log(`  ${pc.dim("Tools:")}        ${toolNames}`);
    }
    console.log();
  }
}

export async function runPluginInfo(pkgQuery?: string): Promise<void> {
  if (!pkgQuery || pkgQuery.startsWith("-")) {
    console.error(pc.red("[ERROR] Please specify an installed plugin name."));
    console.error(pc.dim("Usage: weavetab plugin info <packageName>"));
    process.exitCode = 1;
    return;
  }

  const info = resolveInstalledPluginInfo(pkgQuery);
  if (!info) {
    console.error(pc.red(`[ERROR] Plugin "${pkgQuery}" is not installed.`));
    console.error(pc.dim(`Run ${pc.cyan("weavetab plugin list")} to see installed plugins.`));
    process.exitCode = 1;
    return;
  }

  const verifiedPackages = await getVerifiedPackages();
  const trust = resolvePluginTrust(info.packageName, verifiedPackages, info.dir);
  const disabled = isPluginDisabled(info.packageName);
  const m = info.manifest;
  const pkgJson = info.pkgJson;
  const version = pkgJson?.version || m.version || "1.0.0";
  const perms = normalizePermissions(m.permissions);

  const lines = [
    `${pc.dim("Package:")}      ${pc.bold(info.packageName)}`,
    `${pc.dim("Name:")}         ${m.displayName || m.name || info.packageName}`,
    `${pc.dim("Version:")}      v${version}`,
    `${pc.dim("Status:")}       ${disabled ? pc.yellow("Disabled") : pc.green("Enabled")}`,
    `${pc.dim("Author:")}       ${resolveManifestAuthor(m, pkgJson, "Unknown")}`,
    `${pc.dim("Trust Tier:")}   ${trust.badge}`,
    `${pc.dim("Directory:")}    ${info.dir}`,
    `${pc.dim("Entry:")}        ${m.entry || pkgJson?.main || "dist/index.js"}`,
    `${pc.dim("Instructions:")} ${info.instructions ? pc.green(`${info.instructions.length}/${MAX_INSTRUCTIONS_CHARS} chars`) : pc.dim("None")}`,
    `${pc.dim("Description:")}  ${m.description || "(none)"}`,
  ];

  const cmds = m.commands || [];
  if (cmds.length > 0) {
    lines.push("", pc.bold(`CLI Commands (${cmds.length}):`));
    for (const c of cmds) lines.push(`  • ${pc.cyan(c.name)} — ${pc.dim(c.description || "")}`);
  }

  const tools = m.tools || [];
  if (tools.length > 0) {
    lines.push("", pc.bold(`MCP Tools (${tools.length}):`));
    for (const t of tools) lines.push(`  • ${pc.green(t.name)} — ${pc.dim(t.description || "")}`);
  }

  const prompts = m.prompts || [];
  if (prompts.length > 0) {
    lines.push("", pc.bold(`Prompts (${prompts.length}):`));
    for (const pr of prompts) lines.push(`  • ${pc.magenta(`/${pr.name}`)} — ${pc.dim(pr.description || "")}`);
  }

  const resources = m.resources || [];
  if (resources.length > 0) {
    lines.push("", pc.bold(`Resources (${resources.length}):`));
    for (const rs of resources) lines.push(`  • ${pc.magenta(`@${rs.uri || rs.uriTemplate || rs.name}`)} — ${pc.dim(rs.description || "")}`);
  }

  const permKeys = Object.keys(perms).filter((k) => k !== "fs" || !perms.filesystem);
  if (permKeys.length > 0) {
    lines.push("", pc.bold("Declared Permissions:"));
    for (const k of permKeys) {
      const reason = (perms as any)[k]?.reason;
      lines.push(`  • ${pc.yellow(k)}${reason ? pc.dim(` — ${reason}`) : ""}`);
    }
  }

  console.log();
  console.log(boxen(lines.join("\n"), { padding: 1, borderStyle: "round", borderColor: disabled ? "yellow" : "cyan" }));
  console.log();
}

export async function runPluginEnable(pkgQuery?: string): Promise<void> {
  if (!pkgQuery || pkgQuery.startsWith("-")) {
    console.error(pc.red("[ERROR] Please specify an installed plugin name to enable."));
    console.error(pc.dim("Usage: weavetab plugin enable <packageName>"));
    process.exitCode = 1;
    return;
  }

  const info = resolveInstalledPluginInfo(pkgQuery);
  if (!info) {
    console.error(pc.red(`[ERROR] Plugin "${pkgQuery}" is not installed.`));
    process.exitCode = 1;
    return;
  }

  if (!isPluginDisabled(info.packageName)) {
    console.log(pc.dim(`Plugin "${info.packageName}" is already enabled.`));
    return;
  }

  setPluginEnabled(info.packageName, true);
  console.log(pc.green(`[OK] Enabled plugin "${info.packageName}". Active MCP sessions will hot-load it.`));
}

export async function runPluginDisable(pkgQuery?: string): Promise<void> {
  if (!pkgQuery || pkgQuery.startsWith("-")) {
    console.error(pc.red("[ERROR] Please specify an installed plugin name to disable."));
    console.error(pc.dim("Usage: weavetab plugin disable <packageName>"));
    process.exitCode = 1;
    return;
  }

  const info = resolveInstalledPluginInfo(pkgQuery);
  if (!info) {
    console.error(pc.red(`[ERROR] Plugin "${pkgQuery}" is not installed.`));
    process.exitCode = 1;
    return;
  }

  if (isPluginDisabled(info.packageName)) {
    console.log(pc.dim(`Plugin "${info.packageName}" is already disabled.`));
    return;
  }

  setPluginEnabled(info.packageName, false);
  console.log(pc.yellow(`[OK] Disabled plugin "${info.packageName}". Active MCP sessions will hot-unload it.`));
}

export async function runPluginUse(args: string[]): Promise<void> {
  const pkgQuery = args[0];
  if (!pkgQuery || pkgQuery === "--help" || pkgQuery === "-h") {
    console.log();
    console.log(
      boxen(pc.bold(pc.cyan(" WEAVETAB PLUGIN USE ")), { padding: 0, borderStyle: "round", borderColor: "cyan" })
    );
    console.log();
    console.log(pc.bold("USAGE"));
    console.log(`  ${pc.cyan("weavetab plugin use <plugin>")}                        Inspect plugin commands, tools, prompts & resources`);
    console.log(`  ${pc.cyan("weavetab plugin use <plugin> instructions")}           Read the plugin's operational instructions & CLI commands`);
    console.log(`  ${pc.cyan("weavetab plugin use <plugin> <command> [--flags]")}    Execute a plugin CLI command`);
    console.log(`  ${pc.cyan("weavetab plugin use <plugin> <tool> [--flags]")}       Execute a plugin MCP tool from the CLI`);
    console.log();
    console.log(pc.bold("EXAMPLES"));
    console.log(`  ${pc.dim("$")} weavetab plugin use github repo-summary --repo weavetab/mcp`);
    console.log(`  ${pc.dim("$")} weavetab plugin use realtime status`);
    console.log(`  ${pc.dim("$")} weavetab plugin use chaos instructions`);
    console.log();
    return;
  }

  const info = resolveInstalledPluginInfo(pkgQuery);
  if (!info) {
    console.error(pc.red(`[ERROR] Plugin "${pkgQuery}" is not installed.`));
    console.error(pc.dim(`Install it first with: ${pc.cyan(`weavetab plugin add ${pkgQuery}`)}`));
    process.exitCode = 1;
    return;
  }

  if (isPluginDisabled(info.packageName)) {
    console.error(pc.yellow(`[ERROR] Plugin "${info.packageName}" is disabled.`));
    console.error(pc.dim(`Re-enable it with: ${pc.cyan(`weavetab plugin enable ${info.packageName}`)}`));
    process.exitCode = 1;
    return;
  }

  const plugin = await tryLoadPluginAsync(info.dir, true);
  if (!plugin) {
    console.error(pc.red(`[ERROR] Plugin "${info.packageName}" failed to load from ${info.dir}.`));
    console.error(pc.dim("Check that the entry point exists and builds cleanly."));
    process.exitCode = 1;
    return;
  }

  if (typeof plugin.onLoad === "function") {
    try {
      await plugin.onLoad((plugin as any)._context);
    } catch (err: any) {
      console.error(pc.red(`[ERROR] Plugin "${info.packageName}" onLoad failed: ${err?.message || err}`));
      process.exitCode = 1;
      return;
    }
  }
  const target = args[1];
  const restArgs = args.slice(2);

  // If no target or --help, print overview of commands, tools, prompts, resources, and instructions pointer
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

    if (prompts.length > 0) {
      console.log(pc.bold(`PROMPTS (${prompts.length})`));
      for (const pr of prompts) {
        console.log(`  ${pc.magenta(`/${pr.name}`)} — ${pc.dim(pr.description || "")}`);
      }
      console.log();
    }

    if (resources.length > 0) {
      console.log(pc.bold(`RESOURCES (${resources.length})`));
      for (const rs of resources) {
        console.log(
          `  ${pc.magenta(`@${rs.uri || rs.uriTemplate || rs.name}`)} — ${pc.dim(rs.description || "")}`
        );
      }
      console.log();
    }

    if (plugin.instructions || cmds.length > 0) {
      console.log(
        pc.dim(`Agent Instructions: run `) +
          pc.cyan(`weavetab plugin use ${pkgQuery} instructions`) +
          pc.dim(` to print full instructions & CLI flag schemas.\n`)
      );
    }
    return;
  }

  if (target === "instructions" || target === "--instructions" || target === "agents" || target === "--agents") {
    const manifestCmds = info.manifest?.commands || (plugin.commands || []).map((c) => ({
      name: c.name,
      description: c.description,
      usage: c.usage,
    }));
    if (!plugin.instructions && manifestCmds.length === 0) {
      console.error(pc.yellow(`[WARN] Plugin "${info.packageName}" does not provide instructions or CLI commands.`));
      process.exitCode = 1;
      return;
    }
    console.log(formatPluginInstructionsOutput(info.packageName, plugin.version, plugin.instructions, manifestCmds));
    return;
  }

  let positional: string[];
  let flags: Record<string, any>;
  try {
    ({ positional, flags } = parseCliInvokeArgs(restArgs));
  } catch (err: any) {
    console.error(pc.red(`[ERROR] ${err?.message || err}`));
    process.exitCode = 1;
    return;
  }

  const pluginCtx = (plugin as any)._context;
  const perms = normalizePermissions(plugin.permissions || info.manifest.permissions);

  const connectSession = async (toolOrCmdName: string) => {
    const { loadConfig } = await import("../config/loader.js");
    const { getOrConnect } = await import("../cdp/connector.js");
    const { checkDomain, isToolAllowedForRole } = await import("../security/blacklist.js");
    const cfg = await loadConfig();
    const roleCheck = isToolAllowedForRole(cfg.role, toolOrCmdName);
    if (!roleCheck.allowed) {
      throw new Error(`PERMISSION DENIED: ${roleCheck.reason}`);
    }
    const client = await getOrConnect(cfg);
    if (client.url && !client.isElectron) {
      const domainCheck = checkDomain(client.url, toolOrCmdName, cfg);
      if (!domainCheck.allowed) {
        throw new Error(`DOMAIN BLOCKED: ${domainCheck.reason}`);
      }
    }
    return client.session;
  };

  // 1. CLI Commands (`plugin.commands`)
  const matchedCmd = (plugin.commands || []).find((c) => c.name === target);
  if (matchedCmd) {
    if (!perms.commands?.add) {
      console.error(
        pc.red(
          `[PERMISSION DENIED] Plugin "${info.packageName}" attempted to run CLI command "${target}" without 'permissions.commands.add: true' in weavetab.json.`
        )
      );
      process.exitCode = 1;
      return;
    }

    try {
      const validatedFlags = validateAgainstPluginSchema(matchedCmd.schema || matchedCmd.parameters, flags);

      let session: any = undefined;
      let tabClient: any = undefined;
      if (matchedCmd.requiresSession) {
        session = await connectSession(target);
        tabClient = createCliTabProxy(session);
      }

      const cmdCtx: any = {
        args: positional,
        flags: validatedFlags,
        tab: tabClient,
        desktop: pluginCtx.desktop,
        storage: pluginCtx.storage,
        extension: pluginCtx.extension,
        memory: pluginCtx.memory,
        config: pluginCtx.config,
        logger: pluginCtx.logger,
        session,
        getSession: async () => {
          if (!session) {
            session = await connectSession(target);
            cmdCtx.session = session;
            cmdCtx.tab = createCliTabProxy(session);
          }
          return session;
        },
      };

      const output = await matchedCmd.handler(validatedFlags, cmdCtx);
      if (typeof output === "string") {
        console.log(output);
      } else if (output !== undefined) {
        console.log(JSON.stringify(output, null, 2));
      }
    } catch (err: any) {
      console.error(pc.red(`[ERROR] ${err?.message || err}`));
      process.exitCode = 1;
    }
    return;
  }

  // 2. MCP Tools (`plugin.tools`)
  const matchedTool = (plugin.tools || []).find((t) => t.name === target);
  if (matchedTool) {
    if (!perms.tools?.add) {
      console.error(
        pc.red(
          `[PERMISSION DENIED] Plugin "${info.packageName}" cannot run tool "${target}" without 'permissions.tools.add: true'.`
        )
      );
      process.exitCode = 1;
      return;
    }

    try {
      const validatedArgs = validateAgainstPluginSchema(
        (matchedTool as any).schema || (matchedTool as any).inputSchema || (matchedTool as any).parameters,
        flags
      );
      const { loadConfig } = await import("../config/loader.js");
      const { checkDomain, isToolAllowedForRole } = await import("../security/blacklist.js");
      const cfg = await loadConfig();
      const roleCheck = isToolAllowedForRole(cfg.role, target);
      if (!roleCheck.allowed) {
        console.error(pc.red(`[PERMISSION DENIED] ${roleCheck.reason}`));
        process.exitCode = 1;
        return;
      }

      let session: any = undefined;
      let tabClient: any = undefined;
      if (matchedTool.requiresSession !== false) {
        try {
          const { getOrConnect } = await import("../cdp/connector.js");
          const client = await getOrConnect(cfg);
          session = client.session;
          if (client.url && !client.isElectron) {
            const domainCheck = checkDomain(client.url, target, cfg);
            if (!domainCheck.allowed) {
              console.error(pc.red(`[DOMAIN BLOCKED] ${domainCheck.reason}`));
              process.exitCode = 1;
              return;
            }
          }
          tabClient = createCliTabProxy(session);
        } catch {
          // allow API-capable tools to still run or report their own session error
        }
      }

      const toolCtx = {
        tab: tabClient,
        desktop: pluginCtx.desktop,
        storage: pluginCtx.storage,
        extension: pluginCtx.extension,
        memory: pluginCtx.memory,
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
        if (res.isError) process.exitCode = 1;
      } else if (res !== undefined) {
        console.log(JSON.stringify(res, null, 2));
      }
    } catch (err: any) {
      console.error(pc.red(`[ERROR] ${err?.message || err}`));
      process.exitCode = 1;
    }
    return;
  }

  // 3. Prompts (`/prompt`) or Resources (`@uri`)
  const cleanPromptName = target.startsWith("/") ? target.slice(1) : target;
  const matchedPrompt = (plugin.prompts || []).find((pr) => pr.name === cleanPromptName);
  if (matchedPrompt) {
    if (!perms.prompts?.add) {
      console.error(
        pc.red(`[PERMISSION DENIED] Plugin "${info.packageName}" cannot run prompt "${cleanPromptName}" without 'permissions.prompts.add: true'.`)
      );
      process.exitCode = 1;
      return;
    }
    try {
      const strFlags: Record<string, string> = {};
      for (const [k, v] of Object.entries(flags)) strFlags[k] = String(v);
      const out = await matchedPrompt.handler(strFlags, {
        storage: pluginCtx.storage,
        config: pluginCtx.config,
        logger: pluginCtx.logger,
      });
      console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
    } catch (err: any) {
      console.error(pc.red(`[ERROR] ${err?.message || err}`));
      process.exitCode = 1;
    }
    return;
  }

  const cleanResName = target.startsWith("@") ? target.slice(1) : target;
  const matchedRes = (plugin.resources || []).find(
    (r) => r.name === cleanResName || r.uri === cleanResName || r.uriTemplate === cleanResName
  );
  if (matchedRes) {
    if (!perms.resources?.add) {
      console.error(
        pc.red(`[PERMISSION DENIED] Plugin "${info.packageName}" cannot read resource "${cleanResName}" without 'permissions.resources.add: true'.`)
      );
      process.exitCode = 1;
      return;
    }
    try {
      const uri = matchedRes.uri || cleanResName;
      const out = await matchedRes.read(uri, flags as any, {
        storage: pluginCtx.storage,
        config: pluginCtx.config,
        logger: pluginCtx.logger,
      });
      console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2));
    } catch (err: any) {
      console.error(pc.red(`[ERROR] ${err?.message || err}`));
      process.exitCode = 1;
    }
    return;
  }

  console.error(pc.red(`[ERROR] Target "${target}" not found in plugin "${info.packageName}".`));
  const availableCmds = (plugin.commands || []).map((c) => c.name);
  const availableTools = (plugin.tools || []).map((t) => t.name);
  if (availableCmds.length > 0) {
    console.error(pc.dim(`Available CLI commands: ${availableCmds.join(", ")}`));
  }
  if (availableTools.length > 0) {
    console.error(pc.dim(`Available MCP tools:    ${availableTools.join(", ")}`));
  }
  process.exitCode = 1;
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
    const version = pInfo.pkgJson?.version || pInfo.manifest.version || "1.0.0";
    console.log(
      boxen(pc.bold(pc.cyan(`${pInfo.packageName} — Instructions`)), {
        padding: 0,
        borderStyle: "round",
        borderColor: "cyan",
      })
    );
    const out = formatPluginInstructionsOutput(
      pInfo.packageName,
      version,
      pInfo.instructions,
      pInfo.manifest.commands
    );
    console.log(out);
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
  if (!process.stdin.isTTY) {
    console.error(pc.red("[ERROR] 'weavetab plugin browse' requires an interactive terminal. Use 'weavetab plugin search [query]' instead."));
    process.exitCode = 1;
    return;
  }
  if (process.stdout.isTTY) console.clear();
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
    console.error(pc.red("[ERROR] Please specify a valid package name to remove."));
    console.error(pc.dim("Usage: weavetab plugin remove <packageName>"));
    process.exitCode = 1;
    return;
  }

  const localInfo = resolveInstalledPluginInfo(pkgName);
  const targetPkg = localInfo?.packageName || stripNpmVersion(pkgName).name;

  if (!isValidNpmPackageSpec(targetPkg)) {
    console.error(pc.red(`[ERROR] Invalid package name: "${pkgName}"`));
    process.exitCode = 1;
    return;
  }

  const globalPluginDir = getGlobalPluginDir();
  const inGlobal = fs.existsSync(path.join(globalPluginDir, "node_modules", targetPkg, "package.json"));
  if (!localInfo && !inGlobal) {
    console.error(pc.red(`[ERROR] Plugin "${pkgName}" is not installed.`));
    process.exitCode = 1;
    return;
  }

  const spinner = ora(`Uninstalling ${pc.cyan(targetPkg)} via npm...`).start();
  const result = await runNpmCommand(["uninstall", targetPkg], globalPluginDir);

  if (result.code !== 0) {
    spinner.fail(pc.red(`Failed to remove ${targetPkg}`));
    if (result.stderr) console.error(pc.dim(result.stderr));
    process.exitCode = 1;
    return;
  }

  if (isPluginDisabled(targetPkg)) {
    try { setPluginEnabled(targetPkg, true); } catch {}
  }

  spinner.succeed(pc.green(`removed ${pc.bold(targetPkg)}`));
  touchPluginEpoch();
  console.log(pc.dim("The plugin and its tools have been uninstalled.\n"));
}

export async function runPluginVerify(pkgName: string): Promise<void> {
  if (!pkgName || pkgName.startsWith("-")) {
    console.error(pc.red("[ERROR] Please specify a package name to verify."));
    console.error(pc.dim("Usage: weavetab plugin verify <packageName>"));
    process.exitCode = 1;
    return;
  }

  const spinner = ora(`Checking trust status for ${pc.cyan(pkgName)}...`).start();
  const verifiedPackages = await getVerifiedPackages();
  spinner.stop();

  const localInfo = resolveInstalledPluginInfo(pkgName);
  const resolvedName = localInfo?.packageName || stripNpmVersion(pkgName).name;
  const trust = resolvePluginTrust(resolvedName, verifiedPackages, localInfo?.dir);

  console.log();
  console.log(
    boxen(pc.bold(pc.cyan(` PLUGIN TRUST REPORT: ${resolvedName} `)), {
      padding: 0,
      borderStyle: "round",
      borderColor: "cyan",
    })
  );
  console.log();
  console.log(`  ${pc.dim("Package:")}      ${pc.bold(resolvedName)}`);
  if (localInfo?.pkgJson?.version) {
    console.log(`  ${pc.dim("Version:")}      v${localInfo.pkgJson.version}`);
  }
  if (localInfo) {
    console.log(`  ${pc.dim("Status:")}       ${isPluginDisabled(resolvedName) ? pc.yellow("Disabled") : pc.green("Enabled")}`);
  }
  console.log(`  ${pc.dim("Tier:")}         ${trust.badge} (${trust.label})`);
  console.log(`  ${pc.dim("Details:")}      ${trust.tooltip}`);
  if (localInfo) {
    const text = localInfo.instructions;
    const hasInstructions = Boolean(text);
    const chars = text ? text.length : 0;
    console.log(
      `  ${pc.dim("Instructions:")} ${hasInstructions ? pc.green(`Compliant (${chars}/${MAX_INSTRUCTIONS_CHARS} chars, max ${MAX_INSTRUCTIONS_LINES} lines)`) : pc.dim("None declared")}`
    );
  }
  console.log();

  if (trust.tier === "unverified") {
    console.log(pc.yellow("  Want to get this package verified?"));
    console.log(pc.dim(`  Submit a verification PR to the registry at: ${pc.cyan(REGISTRY_URL)}\n`));
  }
}

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
    console.log(`  ${pc.cyan("use <pkg> [cmd]")}     Execute a plugin CLI command, MCP tool, or print its instructions`);
    console.log(`  ${pc.cyan("info <pkg>")}          Inspect an installed plugin's manifest, tools, commands & permissions`);
    console.log(`  ${pc.cyan("enable <pkg>")}        Enable a disabled plugin (hot-loads into active MCP sessions)`);
    console.log(`  ${pc.cyan("disable <pkg>")}       Disable an installed plugin without uninstalling it`);
    console.log(`  ${pc.cyan("instructions [pkg]")}  Print operational instructions & CLI commands for installed plugins`);
    console.log(`  ${pc.cyan("add <pkg|path>")}      Install a plugin by npm name or local path (alias: install)`);
    console.log(`  ${pc.cyan("update <pkg>")}        Upgrade an installed plugin to a newer published version`);
    console.log(`  ${pc.cyan("list")}                List all installed plugins, status, commands, tools & utilities`);
    console.log(`  ${pc.cyan("remove <pkg>")}        Uninstall a plugin (alias: rm, uninstall)`);
    console.log(`  ${pc.cyan("browse")}              Interactive terminal explorer to browse & install`);
    console.log(`  ${pc.cyan("search [query]")}      Search plugins across official registry & npm`);
    console.log(`  ${pc.cyan("verify <pkg>")}        Check trust tier, registry status, and instructions compliance`);
    console.log();
    console.log(pc.bold("DEVELOPER SDK (@weavetab/sdk)"));
    console.log(`  ${pc.dim("Scaffold a plugin:")}  ${pc.cyan("npx -y @weavetab/sdk init <name>")}`);
    console.log(`  ${pc.dim("Build & validate:")}   ${pc.cyan("npx @weavetab/sdk build")}`);
    console.log();
    console.log(pc.bold("OPTIONS (for 'add' / 'update' / general)"));
    console.log(`  ${pc.cyan("--refresh")}           Invalidate and refresh the verified plugin cache`);
    console.log(`  ${pc.cyan("--official, -O")}      Prefer official @weavetab/plugin-<name>`);
    console.log(`  ${pc.cyan("--community, -C")}     Prefer community package`);
    console.log(`  ${pc.cyan("--yes, -y")}           Bypass interactive warning prompt or auto-select latest update`);
    console.log();
    return;
  }

  if (subcmd === "init" || subcmd === "create" || subcmd === "new" || subcmd === "build" || subcmd === "manifest") {
    const targetName = cleanArgs[1] && !cleanArgs[1].startsWith("-") ? cleanArgs[1] : "<name>";
    console.log(pc.yellow(`\n[Weavetab] Plugin authoring commands belong to the developer SDK (@weavetab/sdk).`));
    console.log(pc.dim("To scaffold a new plugin:   ") + pc.cyan(`npx -y @weavetab/sdk init ${targetName}`));
    console.log(pc.dim("To build/validate a plugin: ") + pc.cyan("npx @weavetab/sdk build"));
    console.log(pc.dim("SDK documentation:          ") + pc.cyan("https://weavetab.dev/docs/sdk-overview\n"));
    return;
  }

  if (subcmd === "use" || subcmd === "run" || subcmd === "exec") {
    await runPluginUse(cleanArgs.slice(1));
    return;
  }

  if (subcmd === "info" || subcmd === "show") {
    await runPluginInfo(cleanArgs[1]);
    return;
  }

  if (subcmd === "enable") {
    await runPluginEnable(cleanArgs[1]);
    return;
  }

  if (subcmd === "disable") {
    await runPluginDisable(cleanArgs[1]);
    return;
  }

  if (subcmd === "instructions" || subcmd === "agents" || subcmd === "guide") {
    await runPluginAgents(cleanArgs[1]);
    return;
  }

  if (subcmd === "add" || subcmd === "install" || subcmd === "i") {
    await runPluginAdd(cleanArgs[1], cleanArgs.slice(2));
    return;
  }

  if (subcmd === "update" || subcmd === "upgrade" || subcmd === "up") {
    await runPluginUpdate(cleanArgs[1], cleanArgs.slice(2));
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

  console.error(pc.red(`[ERROR] Unknown plugin subcommand: "${subcmd}"`));
  console.error(pc.dim("Run 'weavetab plugin --help' to see available commands."));
  process.exitCode = 1;
}
