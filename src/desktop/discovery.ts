/**
 * Weavetab — desktop/discovery.ts
 * Auto-discovery scanner for running Electron desktop applications.
 *
 * Detects:
 *   1. Active Electron instances with open CDP remote debugging ports
 *      (Slack, Discord, VS Code, Notion, Obsidian, Linear, Cursor, etc.).
 *   2. Running Electron processes without remote debugging enabled,
 *      providing actionable launch flags.
 *
 * Weavetab by fy2ne
 */

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
  "visual studio code": "VS Code",
  notion: "Notion",
  obsidian: "Obsidian",
  linear: "Linear",
  spotify: "Spotify",
  postman: "Postman",
  cursor: "Cursor",
  figma: "Figma",
};

/**
 * Fast probe of a potential CDP debug port on 127.0.0.1.
 * Resolves with version/target metadata if open, or null if unreachable.
 */
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
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", async () => {
          try {
            const versionInfo = JSON.parse(data);
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
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
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

/**
 * Infers an application name from CDP version and target metadata.
 */
export function identifyElectronAppName(versionInfo: any, targets: any[]): string {
  const allText = [
    versionInfo?.Browser || "",
    versionInfo?.["User-Agent"] || "",
    ...targets.map((t) => `${t.title || ""} ${t.url || ""}`),
  ].join(" ").toLowerCase();

  for (const [key, displayName] of Object.entries(KNOWN_ELECTRON_PROCS)) {
    if (allText.includes(key)) {
      return displayName;
    }
  }

  // Fallback to first non-empty page title
  const primaryTarget = targets.find((t) => t.type === "page" && t.title);
  if (primaryTarget?.title) {
    return primaryTarget.title.slice(0, 30);
  }

  return "Electron Application";
}

/**
 * Discovers running Electron apps on the host machine.
 * 1. Probes common and provided debug ports for open CDP listeners.
 * 2. Checks OS process list for running Electron apps lacking debug ports.
 */
export async function discoverElectronApps(
  customPorts: number[] = []
): Promise<DiscoveredElectronApp[]> {
  const discovered: DiscoveredElectronApp[] = [];
  const portsToScan = Array.from(new Set([...COMMON_DEBUG_PORTS, ...customPorts]));

  // 1. Probe all candidate debug ports in parallel
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

  // 2. Scan OS process list for known Electron apps without debug ports
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
    // Process list scan is best-effort across restricted OS environments
  }

  return discovered;
}

interface RunningProcess {
  name: string;
  pid: number;
}

async function getRunningElectronProcesses(): Promise<RunningProcess[]> {
  const platform = process.platform;
  const running: RunningProcess[] = [];

  try {
    if (platform === "win32") {
      const { stdout } = await execAsync('tasklist /FO CSV /NH', { timeout: 1500 });
      const lines = stdout.split("\r\n");
      const seenNames = new Set<string>();

      for (const line of lines) {
        if (!line.trim()) continue;
        const parts = line.split('","').map((p) => p.replace(/"/g, ""));
        const exeName = (parts[0] || "").toLowerCase();
        const pid = parseInt(parts[1], 10);

        for (const [key, displayName] of Object.entries(KNOWN_ELECTRON_PROCS)) {
          if (exeName.includes(key) && !seenNames.has(displayName)) {
            seenNames.add(displayName);
            running.push({ name: displayName, pid });
          }
        }
      }
    } else {
      const { stdout } = await execAsync('ps -eo pid,comm', { timeout: 1500 });
      const lines = stdout.split("\n");
      const seenNames = new Set<string>();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [pidStr, ...cmdParts] = trimmed.split(/\s+/);
        const cmd = cmdParts.join(" ").toLowerCase();
        const pid = parseInt(pidStr, 10);

        for (const [key, displayName] of Object.entries(KNOWN_ELECTRON_PROCS)) {
          if (cmd.includes(key) && !seenNames.has(displayName)) {
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

export function isValidElectronExecutablePath(execPath: string): boolean {
  if (!execPath || typeof execPath !== "string") return false;
  const normalizedPath = execPath.toLowerCase().trim();

  // Check for suspicious patterns that might indicate command injection or shell escapes
  const suspiciousPatterns = [
    '%', // URL encoding
    'cmd.exe', 'powershell.exe', 'bash', 'sh', 'wscript.exe', 'cscript.exe'
  ];

  if (suspiciousPatterns.some(pattern => normalizedPath.includes(pattern))) {
    logDebug(`[SECURITY] Electron path validation failed: suspicious pattern in path: ${execPath}`);
    return false;
  }

  try {
    if (!fs.existsSync(execPath)) {
      return false;
    }
    const stat = fs.statSync(execPath);
    if (!stat.isFile()) {
      return false;
    }
  } catch {
    return false;
  }

  return true;
}

export function resolveElectronExecutablePath(appName: string, configuredPath?: string): string | null {
  const normApp = appName.toLowerCase().trim();

  // 1. If configuredPath is provided and valid, return it
  if (configuredPath && isValidElectronExecutablePath(configuredPath)) {
    return path.resolve(configuredPath);
  }

  // 2. If configuredPath was provided, but does not exist, check versioned parent folder (e.g. Squirrel app-*)
  if (configuredPath) {
    try {
      const parsed = path.parse(path.resolve(configuredPath));
      const parentDir = parsed.dir;
      const baseExe = parsed.base || (process.platform === "win32" ? `${appName}.exe` : appName);
      const parentBase = path.basename(parentDir);

      const searchDirs: string[] = [];
      if (parentBase.toLowerCase().startsWith("app-") || parentBase.toLowerCase().startsWith("app_")) {
        searchDirs.push(path.dirname(parentDir));
      } else {
        searchDirs.push(parentDir);
      }

      for (const sDir of searchDirs) {
        if (fs.existsSync(sDir)) {
          const entries = fs.readdirSync(sDir, { withFileTypes: true });
          const versionDirs = entries
            .filter(e => e.isDirectory() && (e.name.startsWith("app-") || e.name.startsWith("app_")))
            .map(e => e.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

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

  // 3. Platform-specific auto-discovery for known apps
  const platform = process.platform;
  const candidates: string[] = [];

  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || "";
    const progFiles = process.env.ProgramFiles || "C:\\Program Files";
    const progFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

    if (normApp === "discord") {
      const discordDir = path.join(localAppData, "Discord");
      if (fs.existsSync(discordDir)) {
        try {
          const entries = fs.readdirSync(discordDir, { withFileTypes: true });
          const vDirs = entries
            .filter(e => e.isDirectory() && e.name.startsWith("app-"))
            .map(e => e.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
          for (const v of vDirs) {
            candidates.push(path.join(discordDir, v, "Discord.exe"));
          }
        } catch {}
      }
      candidates.push(path.join(progFiles, "Discord", "Discord.exe"));
      candidates.push(path.join(progFilesX86, "Discord", "Discord.exe"));
    } else if (normApp === "slack") {
      const slackDir = path.join(localAppData, "slack");
      if (fs.existsSync(slackDir)) {
        try {
          const entries = fs.readdirSync(slackDir, { withFileTypes: true });
          const vDirs = entries
            .filter(e => e.isDirectory() && e.name.startsWith("app-"))
            .map(e => e.name)
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
          for (const v of vDirs) {
            candidates.push(path.join(slackDir, v, "slack.exe"));
          }
        } catch {}
      }
      candidates.push(path.join(progFiles, "Slack", "slack.exe"));
      candidates.push(path.join(progFilesX86, "Slack", "slack.exe"));
    } else if (normApp === "antigravity") {
      candidates.push(path.join(localAppData, "Programs", "antigravity", "Antigravity.exe"));
    } else if (normApp === "antigravity-ide") {
      candidates.push(path.join(localAppData, "Programs", "Antigravity IDE", "Antigravity IDE.exe"));
    } else if (normApp === "code" || normApp === "vscode") {
      candidates.push(path.join(localAppData, "Programs", "Microsoft VS Code", "Code.exe"));
      candidates.push(path.join(progFiles, "Microsoft VS Code", "Code.exe"));
      candidates.push(path.join(progFilesX86, "Microsoft VS Code", "Code.exe"));
    } else if (normApp === "linear") {
      candidates.push(path.join(localAppData, "Programs", "Linear", "Linear.exe"));
    } else if (normApp === "notion") {
      candidates.push(path.join(localAppData, "Programs", "Notion", "Notion.exe"));
    } else if (normApp === "obsidian") {
      candidates.push(path.join(localAppData, "Programs", "obsidian", "Obsidian.exe"));
    }
  } else if (platform === "darwin") {
    if (normApp === "discord") candidates.push("/Applications/Discord.app/Contents/MacOS/Discord");
    else if (normApp === "slack") candidates.push("/Applications/Slack.app/Contents/MacOS/Slack");
    else if (normApp === "code" || normApp === "vscode") candidates.push("/Applications/Visual Studio Code.app/Contents/MacOS/Electron");
    else if (normApp === "linear") candidates.push("/Applications/Linear.app/Contents/MacOS/Linear");
    else if (normApp === "notion") candidates.push("/Applications/Notion.app/Contents/MacOS/Notion");
    else if (normApp === "obsidian") candidates.push("/Applications/Obsidian.app/Contents/MacOS/Obsidian");
  } else {
    // Linux
    candidates.push(`/usr/bin/${normApp}`);
    candidates.push(`/usr/local/bin/${normApp}`);
    candidates.push(`/usr/share/${normApp}/${normApp}`);
  }

  for (const c of candidates) {
    if (isValidElectronExecutablePath(c)) {
      return c;
    }
  }

  return null;
}

