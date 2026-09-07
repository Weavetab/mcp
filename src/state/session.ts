/**
 * Weavetab — state/session.ts
 * SessionRegistry: per-tab CDP client tracking, active tab management, tab lifecycle events, heartbeat.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import { BrowserClient } from "../cdp/connector.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalSystemDir } from "../config/loader.js";

const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_MISSED_LIMIT = 3;
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * HEARTBEAT_MISSED_LIMIT;
const REGISTRY_FILE = path.join(getGlobalSystemDir("registry"), "contexts.json");

export class SessionRegistry {
  private sessions = new Map<string, BrowserClient>();
  private activeTargetIdByAgent = new Map<string, string>(); // agentId -> targetId
  private onNewTabCallbacks: Array<(targetId: string) => void> = [];
  private heartbeatTimestamps = new Map<string, number>();
  private heartbeatIntervals = new Map<string, ReturnType<typeof setInterval>>();
  private browserContextsByAgent = new Map<string, string>(); // agentId -> browserContextId

  constructor() {
    this.loadPersistence();
  }

  private loadPersistence(): void {
    try {
      if (fs.existsSync(REGISTRY_FILE)) {
        const data = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf-8"));
        for (const [agentId, contextId] of Object.entries(data)) {
          this.browserContextsByAgent.set(agentId, contextId as string);
        }
      }
    } catch { /* non-fatal */ }
  }

  private savePersistence(): void {
    try {
      const data: Record<string, string> = {};
      for (const [agentId, contextId] of this.browserContextsByAgent.entries()) {
        data[agentId] = contextId;
      }
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(data, null, 2), "utf-8");
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
    this.savePersistence();
  }

  getActive(agentId?: string, appName?: string): BrowserClient | null {
    if (!agentId) return null;
    const key = appName ? `${agentId}:app:${appName}` : agentId;
    const targetId = this.activeTargetIdByAgent.get(key);
    if (targetId && this.sessions.has(targetId)) {
      return this.sessions.get(targetId) || null;
    }
    if (appName) {
      const match = Array.from(this.sessions.values()).find(c => c.agentId === agentId && c.appName === appName);
      if (match) return match;
    } else {
      const browserTargetId = this.activeTargetIdByAgent.get(agentId);
      if (browserTargetId) {
        const client = this.sessions.get(browserTargetId);
        if (client && !client.isElectron) return client;
      }
    }
    return null;
  }

  getMostRecent(agentId?: string): BrowserClient | null {
    const values = Array.from(this.sessions.values()).filter(c => c.agentId === agentId);
    return values.length > 0 ? values[values.length - 1]! : null;
  }

  setActive(targetId: string, agentId: string, appName?: string): void {
    if (this.sessions.has(targetId)) {
      const client = this.sessions.get(targetId);
      const targetApp = appName || client?.appName;
      const key = targetApp ? `${agentId}:app:${targetApp}` : agentId;
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
    const low = app.toLowerCase();
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
    const key = client.appName ? `${client.agentId}:app:${client.appName}` : client.agentId;
    if (!this.activeTargetIdByAgent.has(key)) {
      this.activeTargetIdByAgent.set(key, targetId);
    }
  }

  unregister(targetId: string): void {
    this.stopHeartbeat(targetId);
    const client = this.sessions.get(targetId);
    if (client) {
      client.session.close().catch(() => {});
      this.sessions.delete(targetId);
      
      const key = client.appName ? `${client.agentId}:app:${client.appName}` : client.agentId;
      const activeForAgent = this.activeTargetIdByAgent.get(key);
      if (activeForAgent === targetId) {
        const agentTabs = Array.from(this.sessions.values()).filter(c => c.agentId === client.agentId && c.appName === client.appName);
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
    if (this.heartbeatIntervals.has(targetId)) return;
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
        // heartbeat failed — tab may be dead, will be caught by getHealth()
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

  onNewTab(callback: (targetId: string) => void): void {
    this.onNewTabCallbacks.push(callback);
  }

  offNewTab(callback: (targetId: string) => void): void {
    this.onNewTabCallbacks = this.onNewTabCallbacks.filter(cb => cb !== callback);
  }

  notifyNewTab(targetId: string): void {
    for (const cb of this.onNewTabCallbacks) {
      cb(targetId);
    }
  }
}

export const sessionRegistry = new SessionRegistry();
