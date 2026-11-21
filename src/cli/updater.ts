import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const UPDATE_CACHE_FILE = path.join(os.homedir(), ".weavetab-system", "cache", "update_check.json");
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

function parseSemver(ver: string): [number, number, number, string] {
  const cleaned = String(ver || "0.0.0").trim().replace(/^v/i, "").split("+")[0] || "0.0.0";
  const [core, prerelease = ""] = cleaned.split("-", 2);
  const parts = (core || "0.0.0").split(".").map((n) => parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0, prerelease];
}

export function isNewerVersion(current: string, latest: string): boolean {
  const [majC, minC, patC, preC] = parseSemver(current);
  const [majL, minL, patL, preL] = parseSemver(latest);
  if (majL !== majC) return majL > majC;
  if (minL !== minC) return minL > minC;
  if (patL !== patC) return patL > patC;
  if (!preC && preL) return false;
  if (preC && !preL) return true;
  if (preC && preL) return preL.localeCompare(preC) > 0;
  return false;
}

export async function checkForUpdates(force = false): Promise<void> {
  try {
    const now = Date.now();

    if (!force && fs.existsSync(UPDATE_CACHE_FILE)) {
      try {
        const cached = JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, "utf-8"));
        if (cached.lastChecked && now - cached.lastChecked < CHECK_INTERVAL_MS) {
          return;
        }
      } catch { /* malformed cache */ }
    }

    const packageJsonPath = path.resolve(__dirname, "../../package.json");
    if (!fs.existsSync(packageJsonPath)) return;

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const currentVersion = pkg.version as string;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1500);
    timeoutId.unref?.();

    let res: Response;
    try {
      res = await fetch("https://registry.npmjs.org/@weavetab/mcp/latest", {
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!res.ok) return;

    const data = (await res.json()) as { version: string };
    const latestVersion = data.version;

    try {
      fs.mkdirSync(path.dirname(UPDATE_CACHE_FILE), { recursive: true });
      fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify({ lastChecked: now, latestVersion }), "utf-8");
    } catch { /* non-fatal */ }

    if (isNewerVersion(currentVersion, latestVersion)) {
      await printUpdateBox(currentVersion, latestVersion);
    }
  } catch {
    // silently fail if offline
  }
}

async function printUpdateBox(current: string, latest: string): Promise<void> {
  try {
    const boxen = (await import("boxen")).default;
    const chalk = (await import("chalk")).default;

    const msg = [
      chalk.bold(`Update available! `) + chalk.dim(current) + chalk.reset(` → `) + chalk.green(latest),
      `Run ${chalk.cyan("npm i -g @weavetab/mcp")} to update.`,
      ``,
      `Changelog: ${chalk.blue(`https://github.com/weavetab/mcp/releases/tag/v${latest}`)}`,
    ].join("\n");

    const box = boxen(msg, {
      padding: 1,
      margin: 1,
      align: "center",
      borderColor: "yellow",
      borderStyle: "round",
    });

    console.error(box);
  } catch {
    console.error(`\n[Weavetab MCP] Update available: ${current} -> ${latest}`);
    console.error(`Run "npm i -g @weavetab/mcp" to update.`);
    console.error(`Changelog: https://github.com/weavetab/mcp/releases/tag/v${latest}\n`);
  }
}
