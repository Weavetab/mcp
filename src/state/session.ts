import CDP from "chrome-remote-interface";
import { BrowserClient } from "../cdp/connector.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalSystemDir } from "../config/loader.js";
import { SessionSecretTracker } from "../security/secrets.js";

const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_MISSED_LIMIT = 3;
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISSED_LIMIT;
const REGISTRY_FILE = path.join(getGlobalSystemDir("registry"), "contexts.json");

export class SessionRegistry {
  private sessions = new Map<string, BrowserClient>();
  private activeTargetIdByAgent = new Map<string, string>();
  private heartbeatTimestamps = new Map<string, number>();
  private heartbeatIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private browserContextsByAgent = new Map<string, string>();

  constructor() {
    this.loadPersistedContexts();
  }

  private loadPersistedContexts(): void {
    this.browserContextsByAgent.clear();
    try {
      if (fs.existsSync(REGISTRY_FILE)) {
        fs.unlinkSync(REGISTRY_FILE);
      }
    } catch { /* non-fatal */ }
  }

  getBrowserContextIdForAgent(agentId: string): string | undefined {
    return this.browserContextsByAgent.get(agentId);
  }

  getAgentForBrowserContextId(contextId: string): string | undefined {
    for (const [agentId, cid] of this.browserContextsByAgent.entries()) {
      if (cid === contextId) return agentId;
    }
    return undefined;
  }

  setBrowserContextIdForAgent(agentId: string, contextId: string): void {
    this.browserContextsByAgent.set(agentId, contextId);
  }

  getActive(agentId?: string, appName?: string): BrowserClient | null {
    if (!agentId) return null;
    const normApp = appName ? appName.toLowerCase().trim() : undefined;
    const key = normApp ? `${agentId}:app:${normApp}` : agentId;
    const targetId = this.activeTargetIdByAgent.get(key);
    if (targetId && this.sessions.has(targetId)) {
      const candidate = this.sessions.get(targetId)!;
      if (normApp ? candidate.appName?.toLowerCase().trim() === normApp : !candidate.isElectron) {
        return candidate;
      }
    }
    if (normApp) {
      const match = Array.from(this.sessions.values()).find(
        c => c.agentId === agentId && c.appName?.toLowerCase().trim() === normApp
      );
      if (match) return match;
    } else {
      const match = Array.from(this.sessions.values()).find(
        c => c.agentId === agentId && !c.isElectron
      );
      if (match) return match;
    }
    return null;
  }

  setActive(targetId: string, agentId: string, appName?: string): void {
    if (this.sessions.has(targetId)) {
      const client = this.sessions.get(targetId);
      const rawApp = appName || client?.appName;
      const normApp = rawApp ? rawApp.toLowerCase().trim() : undefined;
      const key = normApp ? `${agentId}:app:${normApp}` : agentId;
      this.activeTargetIdByAgent.set(key, targetId);
    }
  }

  private lastActiveApp: string | null = null;

  getLastActiveApp(): string | null {
    return this.lastActiveApp;
  }

  setLastActiveApp(app?: string | null): void {
    if (!app) {
      this.lastActiveApp = null;
      return;
    }
    const low = app.toLowerCase().trim();
    if (low !== "browser" && low !== "chrome" && low !== "chromium") {
      this.lastActiveApp = low;
    } else {
      this.lastActiveApp = null;
    }
  }

  findClientByTargetId(targetId: string): BrowserClient | null {
    return this.sessions.get(targetId) || null;
  }

  getActiveElectronClients(): BrowserClient[] {
    return Array.from(this.sessions.values()).filter(c => c.isElectron);
  }

  isBrowserSessionActive(): boolean {
    return Array.from(this.sessions.values()).some(c => !c.isElectron);
  }

  getAll(): BrowserClient[] {
    return Array.from(this.sessions.values());
  }

  getAllForAgent(agentId: string): BrowserClient[] {
    return Array.from(this.sessions.values()).filter(c => c.agentId === agentId);
  }

  register(targetId: string, client: BrowserClient): void {
    this.sessions.set(targetId, client);
    this.heartbeatTimestamps.set(targetId, Date.now());
    this.startHeartbeat(targetId, client.session);
    const normApp = client.appName ? client.appName.toLowerCase().trim() : undefined;
    const key = normApp ? `${client.agentId}:app:${normApp}` : client.agentId;
    if (!this.activeTargetIdByAgent.has(key)) {
      this.activeTargetIdByAgent.set(key, targetId);
    }
  }

  unregister(targetId: string): void {
    this.stopHeartbeat(targetId);
    SessionSecretTracker.clearSession(targetId);
    const client = this.sessions.get(targetId);
    if (client) {
      client.session.close().catch(() => {});
      this.sessions.delete(targetId);

      const normApp = client.appName ? client.appName.toLowerCase().trim() : undefined;
      const key = normApp ? `${client.agentId}:app:${normApp}` : client.agentId;
      const activeForAgent = this.activeTargetIdByAgent.get(key);
      if (activeForAgent === targetId) {
        const agentTabs = Array.from(this.sessions.values()).filter(
          c => c.agentId === client.agentId && (c.appName ? c.appName.toLowerCase().trim() : undefined) === normApp && Boolean(c.isElectron) === Boolean(client.isElectron)
        );
        if (agentTabs.length > 0) {
          this.activeTargetIdByAgent.set(key, agentTabs[agentTabs.length - 1]!.targetId);
        } else {
          this.activeTargetIdByAgent.delete(key);
        }
      }
    }
    this.heartbeatTimestamps.delete(targetId);
  }

  getHealth(targetId: string): "alive" | "dead" | "unreachable" {
    if (!this.sessions.has(targetId)) return "unreachable";
    const lastBeat = this.heartbeatTimestamps.get(targetId);
    if (!lastBeat) return "unreachable";
    const elapsed = Date.now() - lastBeat;
    if (elapsed > HEARTBEAT_TIMEOUT_MS) return "dead";
    return "alive";
  }

  beatHeartbeat(targetId: string): void {
    this.heartbeatTimestamps.set(targetId, Date.now());
  }

  private startHeartbeat(targetId: string, session: CDP.Client): void {
    this.stopHeartbeat(targetId);
    const interval = setInterval(async () => {
      try {
        const { result } = await session.Runtime.evaluate({
          expression: `document.readyState`,
          returnByValue: true,
        });
        if (result?.value) {
          this.beatHeartbeat(targetId);
        }
      } catch {
        // tab may be dead, caught by getHealth()
      }
    }, HEARTBEAT_INTERVAL_MS);
    interval.unref();
    this.heartbeatIntervals.set(targetId, interval);
  }

  private stopHeartbeat(targetId: string): void {
    const interval = this.heartbeatIntervals.get(targetId);
    if (interval) {
      clearInterval(interval);
      this.heartbeatIntervals.delete(targetId);
    }
  }
}

export const sessionRegistry = new SessionRegistry();
