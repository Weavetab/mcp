import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { logDebug } from "../audit/logger.js";

const execAsync = promisify(exec);

export interface DiscoveredElectronApp {
  name: string;
  port?: number;
  status: "debug_port_open" | "process_running_no_debug_port";
  title?: string;
  webSocketDebuggerUrl?: string;
  browserVersion?: string;
  pid?: number;
  recommendation?: string;
}

export const COMMON_DEBUG_PORTS = [9222, 9229, 9333, 8315, 9223, 9224];

const KNOWN_ELECTRON_PROCS: Record<string, string> = {
  slack: "Slack",
  discord: "Discord",
  code: "VS Code",
  vscode: "VS Code",
  "vs code": "VS Code",
  "visual studio code": "VS Code",
  notion: "Notion",
  obsidian: "Obsidian",
  linear: "Linear",
  spotify: "Spotify",
  postman: "Postman",
  cursor: "Cursor",
  figma: "Figma",
};

export function normalizeElectronAppName(name: string): string {
  const k = name.toLowerCase().trim();
  return (KNOWN_ELECTRON_PROCS[k] || name.trim()).toLowerCase();
}

export async function probeDebugPort(
  port: number,
  timeoutMs = 300
): Promise<{ versionInfo: any; targets: any[] } | null> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/json/version`,
      { timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", async () => {
          try {
            const versionInfo = JSON.parse(raw);
            const targets = await fetchTargets(port, timeoutMs).catch(() => []);
            resolve({ versionInfo, targets });
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

export async function fetchTargets(port: number, timeoutMs = 300): Promise<any[]> {
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${port}/json/list`,
      { timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve([]);
        }
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
  });
}

function matchesAppKeyword(text: string, key: string): boolean {
  if (key === "code") {
    return /\b(vs\s*code|visual\s+studio\s+code|vscode-file|vscode-app|code\.exe)\b/i.test(text);
  }
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}

export function identifyElectronAppName(versionInfo: any, targets: any[]): string {
  const allText = [
    versionInfo?.Browser || "",
    versionInfo?.["User-Agent"] || "",
    ...targets.map((t) => `${t.title || ""} ${t.url || ""}`),
  ].join(" ").toLowerCase();

  for (const [key, displayName] of Object.entries(KNOWN_ELECTRON_PROCS)) {
    if (matchesAppKeyword(allText, key)) {
      return displayName;
    }
  }

  const primaryTarget = targets.find((t) => t.type === "page" && t.title);
  if (primaryTarget?.title) {
    return primaryTarget.title.slice(0, 30);
  }

  return "Electron Application";
}

export async function discoverElectronApps(
  customPorts: number[] = []
): Promise<DiscoveredElectronApp[]> {
  const discovered: DiscoveredElectronApp[] = [];
  const portsToScan = Array.from(new Set([...COMMON_DEBUG_PORTS, ...customPorts]));

  const probeResults = await Promise.all(
    portsToScan.map(async (port) => ({
      port,
      res: await probeDebugPort(port),
    }))
  );

  const openAppNames = new Set<string>();

  for (const { port, res } of probeResults) {
    if (res) {
      const name = identifyElectronAppName(res.versionInfo, res.targets);
      openAppNames.add(name.toLowerCase());
      discovered.push({
        name,
        port,
        status: "debug_port_open",
        title: res.targets.find((t) => t.title)?.title || undefined,
        webSocketDebuggerUrl: res.versionInfo.webSocketDebuggerUrl,
        browserVersion: res.versionInfo.Browser,
      });
    }
  }

  try {
    const runningProcs = await getRunningElectronProcesses();
    for (const proc of runningProcs) {
      if (!openAppNames.has(proc.name.toLowerCase())) {
        discovered.push({
          name: proc.name,
          pid: proc.pid,
          status: "process_running_no_debug_port",
          recommendation: `Launch or restart ${proc.name} with: --remote-debugging-port=9222`,
        });
      }
    }
  } catch {
    // best-effort across restricted OS environments
  }

  return discovered;
}

interface RunningProcess {
  name: string;
  pid: number;
}

function matchesProcessName(exeOrCmd: string, key: string): boolean {
  const base = path.basename(exeOrCmd).toLowerCase().replace(/\.exe$/, "");
  if (key === "code") {
    return base === "code" || base === "vscode" || /\bvisual studio code\b/i.test(exeOrCmd);
  }
  return base === key || matchesAppKeyword(base, key);
}

async function getRunningElectronProcesses(): Promise<RunningProcess[]> {
  const platform = process.platform;
  const running: RunningProcess[] = [];

  try {
    if (platform === "win32") {
      const { stdout } = await execAsync("tasklist /FO CSV /NH", { timeout: 1500 });
      const lines = stdout.split(/\r?\n/);
      const seenNames = new Set<string>();

      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split('","').map((p) => p.replace(/"/g, ""));
        const exeName = (parts[0] || "").toLowerCase();
        const pid = parseInt(parts[1] || "0", 10);

        for (const [key, displayName] of Object.entries(KNOWN_ELECTRON_PROCS)) {
          if (matchesProcessName(exeName, key) && !seenNames.has(displayName)) {
            seenNames.add(displayName);
            running.push({ name: displayName, pid });
          }
        }
      }
    } else {
      const { stdout } = await execAsync("ps -eo pid,comm", { timeout: 1500 });
      const lines = stdout.split("\n");
      const seenNames = new Set<string>();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [pidStr, ...cmdParts] = trimmed.split(/\s+/);
        const cmd = cmdParts.join(" ").toLowerCase();
        const pid = parseInt(pidStr || "0", 10);

        for (const [key, displayName] of Object.entries(KNOWN_ELECTRON_PROCS)) {
          if (matchesProcessName(cmd, key) && !seenNames.has(displayName)) {
            seenNames.add(displayName);
            running.push({ name: displayName, pid });
          }
        }
      }
    }
  } catch {
    // ignore
  }

  return running;
}

const BLOCKED_SCRIPT_EXTENSIONS = new Set([".bat", ".cmd", ".ps1", ".vbs", ".sh", ".js", ".wsf"]);
const BLOCKED_SHELL_BINARIES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "wscript",
  "wscript.exe",
  "cscript",
  "cscript.exe",
]);

export function isValidElectronExecutablePath(execPath: string): boolean {
  if (!execPath || typeof execPath !== "string") return false;
  const trimmed = execPath.trim();
  const normalizedPath = trimmed.toLowerCase();

  const forbiddenChars = ["%", ";", "|", "&", "`", "$", "\n", "\r", "\0"];
  if (forbiddenChars.some((ch) => normalizedPath.includes(ch))) {
    logDebug(`[SECURITY] Electron path validation failed: forbidden char in path: ${execPath}`);
    return false;
  }

  const rawSegments = trimmed.split(/[\\/]+/);
  if (rawSegments.includes("..")) {
    logDebug(`[SECURITY] Electron path validation failed: traversal segment in path: ${execPath}`);
    return false;
  }

  const baseName = path.basename(normalizedPath);
  const ext = path.extname(baseName);
  if (BLOCKED_SCRIPT_EXTENSIONS.has(ext)) {
    logDebug(`[SECURITY] Electron path validation failed: script extension blocked: ${execPath}`);
    return false;
  }

  if (BLOCKED_SHELL_BINARIES.has(baseName)) {
    logDebug(`[SECURITY] Electron path validation failed: blocked shell binary: ${execPath}`);
    return false;
  }

  try {
    const resolved = path.resolve(trimmed);
    if (!fs.existsSync(resolved)) {
      return false;
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

function isSquirrelVersionDir(dirName: string): boolean {
  const low = dirName.toLowerCase();
  return low.startsWith("app-") || low.startsWith("app_");
}

export function resolveElectronExecutablePath(appName: string, configuredPath?: string): string | null {
  const normApp = appName.toLowerCase().trim();

  if (configuredPath && isValidElectronExecutablePath(configuredPath)) {
    return path.resolve(configuredPath);
  }

  if (configuredPath) {
    try {
      const parsed = path.parse(path.resolve(configuredPath));
      const parentDir = parsed.dir;
      const baseExe = parsed.base || (process.platform === "win32" ? `${appName}.exe` : appName);
      const parentBase = path.basename(parentDir);

      const searchDirs: string[] = [];
      if (isSquirrelVersionDir(parentBase)) {
        searchDirs.push(path.dirname(parentDir));
      } else {
        searchDirs.push(parentDir);
      }

      for (const sDir of searchDirs) {
        if (fs.existsSync(sDir)) {
          const entries = fs.readdirSync(sDir, { withFileTypes: true });
          const versionDirs = entries
            .filter(e => e.isDirectory() && isSquirrelVersionDir(e.name))
            .map(e => e.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));

          for (const vDir of versionDirs) {
            const candidate = path.join(sDir, vDir, baseExe);
            if (isValidElectronExecutablePath(candidate)) {
              return candidate;
            }
          }

          const directCandidate = path.join(sDir, baseExe);
          if (isValidElectronExecutablePath(directCandidate)) {
            return directCandidate;
          }
        }
      }
    } catch { /* ignore fallback errors */ }
  }

  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim() || "";
    const progFiles = process.env.ProgramFiles || "C:\\Program Files";
    const progFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

    if (normApp === "discord") {
      if (localAppData) {
        const discordDir = path.join(localAppData, "Discord");
        if (fs.existsSync(discordDir)) {
          try {
            const entries = fs.readdirSync(discordDir, { withFileTypes: true });
            const vDirs = entries
              .filter(e => e.isDirectory() && isSquirrelVersionDir(e.name))
              .map(e => e.name)
              .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
            for (const v of vDirs) {
              candidates.push(path.join(discordDir, v, "Discord.exe"));
            }
          } catch {}
        }
      }
      candidates.push(path.join(progFiles, "Discord", "Discord.exe"));
      candidates.push(path.join(progFilesX86, "Discord", "Discord.exe"));
    } else if (normApp === "slack") {
      if (localAppData) {
        const slackDir = path.join(localAppData, "slack");
        if (fs.existsSync(slackDir)) {
          try {
            const entries = fs.readdirSync(slackDir, { withFileTypes: true });
            const vDirs = entries
              .filter(e => e.isDirectory() && isSquirrelVersionDir(e.name))
              .map(e => e.name)
              .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
            for (const v of vDirs) {
              candidates.push(path.join(slackDir, v, "slack.exe"));
            }
          } catch {}
        }
      }
      candidates.push(path.join(progFiles, "Slack", "slack.exe"));
      candidates.push(path.join(progFilesX86, "Slack", "slack.exe"));
    } else if (normApp === "antigravity") {
      if (localAppData) candidates.push(path.join(localAppData, "Programs", "antigravity", "Antigravity.exe"));
    } else if (normApp === "antigravity-ide") {
      if (localAppData) candidates.push(path.join(localAppData, "Programs", "Antigravity IDE", "Antigravity IDE.exe"));
    } else if (normApp === "code" || normApp === "vscode" || normApp === "vs code") {
      if (localAppData) candidates.push(path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"));
      candidates.push(path.join(progFiles, "Microsoft VS Code", "Code.exe"));
      candidates.push(path.join(progFilesX86, "Microsoft VS Code", "Code.exe"));
    } else if (normApp === "cursor") {
      if (localAppData) candidates.push(path.join(localAppData, "Programs", "cursor", "Cursor.exe"));
    } else if (normApp === "linear") {
      if (localAppData) candidates.push(path.join(localAppData, "Programs", "Linear", "Linear.exe"));
    } else if (normApp === "notion") {
      if (localAppData) candidates.push(path.join(localAppData, "Programs", "Notion", "Notion.exe"));
    } else if (normApp === "obsidian") {
      if (localAppData) candidates.push(path.join(localAppData, "Programs", "obsidian", "Obsidian.exe"));
    }
  } else if (platform === "darwin") {
    const homeApps = path.join(process.env.HOME || "", "Applications");
    if (normApp === "discord") {
      candidates.push("/Applications/Discord.app/Contents/MacOS/Discord");
      candidates.push(path.join(homeApps, "Discord.app/Contents/MacOS/Discord"));
    } else if (normApp === "slack") {
      candidates.push("/Applications/Slack.app/Contents/MacOS/Slack");
      candidates.push(path.join(homeApps, "Slack.app/Contents/MacOS/Slack"));
    } else if (normApp === "code" || normApp === "vscode" || normApp === "vs code") {
      candidates.push("/Applications/Visual Studio Code.app/Contents/MacOS/Electron");
      candidates.push(path.join(homeApps, "Visual Studio Code.app/Contents/MacOS/Electron"));
    } else if (normApp === "cursor") {
      candidates.push("/Applications/Cursor.app/Contents/MacOS/Cursor");
      candidates.push(path.join(homeApps, "Cursor.app/Contents/MacOS/Cursor"));
    } else if (normApp === "linear") {
      candidates.push("/Applications/Linear.app/Contents/MacOS/Linear");
      candidates.push(path.join(homeApps, "Linear.app/Contents/MacOS/Linear"));
    } else if (normApp === "notion") {
      candidates.push("/Applications/Notion.app/Contents/MacOS/Notion");
      candidates.push(path.join(homeApps, "Notion.app/Contents/MacOS/Notion"));
    } else if (normApp === "obsidian") {
      candidates.push("/Applications/Obsidian.app/Contents/MacOS/Obsidian");
      candidates.push(path.join(homeApps, "Obsidian.app/Contents/MacOS/Obsidian"));
    }
  } else {
    const binName = (normApp === "vscode" || normApp === "vs code") ? "code" : normApp;
    candidates.push(`/usr/bin/${binName}`);
    candidates.push(`/usr/local/bin/${binName}`);
    candidates.push(`/usr/share/${binName}/${binName}`);
    candidates.push(`/opt/${binName}/${binName}`);
    candidates.push(`/snap/bin/${binName}`);
  }

  for (const c of candidates) {
    if (isValidElectronExecutablePath(c)) {
      return c;
    }
  }

  return null;
}
