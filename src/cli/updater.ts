import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function checkForUpdates(): Promise<void> {
  try {
    // Read local package.json to get current version
    const packageJsonPath = path.resolve(__dirname, "../../package.json");
    if (!fs.existsSync(packageJsonPath)) return;
    
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const currentVersion = pkg.version as string;

    // Fast, non-blocking fetch with 2-second timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);

    const res = await fetch("https://registry.npmjs.org/@weavetab/mcp/latest", {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) return;

    const data = await res.json() as { version: string };
    const latestVersion = data.version;

    // Simple version comparison (assumes semver format like x.y.z)
    if (isNewerVersion(currentVersion, latestVersion)) {
      await printUpdateBox(currentVersion, latestVersion);
    }
  } catch (err) {
    // Silently fail if offline or npm is down
  }
}

function isNewerVersion(current: string, latest: string): boolean {
  const cParts = current.replace(/[^0-9.]/g, "").split(".").map(Number);
  const lParts = latest.replace(/[^0-9.]/g, "").split(".").map(Number);
  
  for (let i = 0; i < Math.max(cParts.length, lParts.length); i++) {
    const c = cParts[i] || 0;
    const l = lParts[i] || 0;
    if (l > c) return true;
    if (l < c) return false;
  }
  return false;
}

async function printUpdateBox(current: string, latest: string): Promise<void> {
  try {
    const boxen = (await import("boxen")).default;
    const chalk = (await import("chalk")).default;

    const msg = [
      chalk.bold(`Update available! `) + chalk.dim(current) + chalk.reset(` → `) + chalk.green(latest),
      `Run ${chalk.cyan("npm i -g @weavetab/mcp")} to update.`,
      ``,
      `Changelog: ${chalk.blue(`https://github.com/weavetab/mcp/changelog/v${latest}`)}`
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
    // Fallback if formatting fails
    console.error(`\n[Weavetab MCP] Update available: ${current} -> ${latest}`);
    console.error(`Run "npm i -g @weavetab/mcp" to update.`);
    console.error(`Changelog: https://github.com/weavetab/mcp/changelog/v${latest}\n`);
  }
}
