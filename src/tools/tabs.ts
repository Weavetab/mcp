import { logDebug } from "../audit/logger.js";
import CDP from "chrome-remote-interface";
import { logAction } from "../audit/logger.js";
import { connectToTab, getPort, getTabList } from "../cdp/connector.js";
import { sessionRegistry } from "../state/session.js";
import type { Config } from "../config/loader.js";
import { clearTabCache } from "../state/cache.js";
import { readLock } from "../cdp/lock.js";
import { resetLoopCounter } from "../intelligence/trail.js";
import { getConfigAgentId, getConfigMaxTabs } from "../config/loader.js";

/** Resolve the active CDP port — live > lock file */
function resolvePort(_config: Config, appName?: string): number {
  if (appName) {
    const lock = readLock(appName);
    if (lock && lock.port) return lock.port;
    throw new Error(`[!] No active session for Electron app "${appName}". Launch it first.`);
  }
  const port = getPort() || readLock()?.port;
  if (!port) throw new Error("[!] No active browser session. Run browser_navigate first.");
  return port;
}

const IDLE_THRESHOLD_MS = 30_000;
const lastActivityMs = new Map<string, number>();

// Phase 3: Semantic Tab Registry
const semanticScores = new Map<string, number>();
const lockedTabIds = new Set<string>();

export function recordTabActivity(targetId: string): void {
  lastActivityMs.set(targetId, Date.now());
}

export function lockTab(targetId: string): void {
  lockedTabIds.add(targetId);
  logAction("browser_tabs", targetId, `Locked tab to prevent auto-close`);
}

export function unlockTab(targetId: string): void {
  lockedTabIds.delete(targetId);
}

// Score a tab based on title/url to determine importance (1-100)
// Higher score = More critical = Less likely to be closed
function calculateSemanticScore(url: string, title: string): number {
  let score = 10; // base score
  const t = (title + " " + url).toLowerCase();
  
  if (t.includes("login") || t.includes("sign in") || t.includes("auth")) score += 60;
  if (t.includes("checkout") || t.includes("payment") || t.includes("cart")) score += 70;
  if (t.includes("dashboard") || t.includes("admin")) score += 40;
  if (t.includes("mail") || t.includes("inbox")) score += 30;

  return Math.min(score, 100);
}

export async function evaluateTabSemantics(targetId: string, appName?: string): Promise<void> {
  try {
    const client = await connectToTab(targetId, undefined, undefined, undefined, appName);
    const result = await client.session.Runtime.evaluate({
      expression: `JSON.stringify({ title: document.title, url: location.href })`,
      returnByValue: true
    });
    if (result && result.result.value) {
      const data = JSON.parse(result.result.value as string);
      const score = calculateSemanticScore(data.url, data.title);
      semanticScores.set(targetId, score);
      
      // Auto-lock highly critical tabs
      if (score >= 70) lockTab(targetId);
    }
  } catch (e) {
    // Silently fail if page isn't ready
  }
}

function isIdleTab(targetId: string, activeTargetId: string | undefined): boolean {
  if (targetId === activeTargetId) return false;
  if (lockedTabIds.has(targetId)) return false;
  const lastSeen = lastActivityMs.get(targetId) ?? 0;
  return Date.now() - lastSeen > IDLE_THRESHOLD_MS;
}

export interface TabInfo {
  id: string;
  title: string;
  url: string;
  status: "active" | "idle" | "loading" | "locked" | "alive" | "dead" | "unreachable";
  health: "alive" | "dead" | "unreachable";
  score: number;
}

// ─── Auto-close oldest, lowest-score idle tab ────────────────────────────────

async function enforceMaxTabs(config: Config): Promise<void> {
  const port = resolvePort(config);
  const pages = await getTabList(getConfigAgentId(config));

  if (pages.length < getConfigMaxTabs(config)) return;

  const activeTargetId = sessionRegistry.getActive(getConfigAgentId(config))?.targetId;

  // Find oldest idle tab, weighted by semantic score
  const idleCandidates = pages
    .filter((t: any) => isIdleTab(t.id, activeTargetId))
    .sort((a: any, b: any) => {
      const scoreA = semanticScores.get(a.id) ?? 10;
      const scoreB = semanticScores.get(b.id) ?? 10;
      if (scoreA !== scoreB) return scoreA - scoreB; // Lower score closed first
      return (lastActivityMs.get(a.id) ?? 0) - (lastActivityMs.get(b.id) ?? 0); // Older closed first
    });

  if (idleCandidates.length === 0) {
    logDebug("[Weavetab] maxTabs reached but no closable idle tab found.");
    return;
  }

  const victim = idleCandidates[0]!;
  logDebug(`[Weavetab] maxTabs (${getConfigMaxTabs(config)}) reached — closing lowest-score tab: ${victim.id} (${victim.title})`);
  await CDP.Close({ host: "127.0.0.1", port, id: victim.id });
  clearTabCache(victim.id);
  sessionRegistry.unregister(victim.id);
  lastActivityMs.delete(victim.id);
  semanticScores.delete(victim.id);
  lockedTabIds.delete(victim.id);
  logAction("browser_tabs", victim.id, `auto-closed idle tab: ${victim.title}`);
}

// ─── Tools ────────────────────────────────────────────────────────────────────

export async function WeavetabOpen(
  url: string,
  config: Config,
  reuse = true,
  appName?: string
): Promise<{ success: true; tabId: string; url: string; reused?: boolean }> {
  // Infer appName from active session if omitted
  let resolvedAppName = appName;
  if (!resolvedAppName) {
    const lastApp = sessionRegistry.getLastActiveApp();
    if (lastApp) {
      resolvedAppName = lastApp;
    }
  }

  const port = resolvePort(config, resolvedAppName);

  // Tab reuse: if same URL is already open, focus it instead of duplicating
  if (reuse && url) {
    try {
      const targets = await getTabList(getConfigAgentId(config), resolvedAppName);
      const existing = targets.find(
        (t: any) => t.url === url
      );
      if (existing) {
        const client = await connectToTab(existing.id, undefined, undefined, undefined, resolvedAppName);
        await client.session.Target.activateTarget({ targetId: existing.id });
        sessionRegistry.setActive(existing.id, getConfigAgentId(config), resolvedAppName);
        recordTabActivity(existing.id);
        logAction("browser_tabs", url, `reused existing tab ${existing.id}`);
        return { success: true, tabId: existing.id, url, reused: true };
      }
    } catch { /* fall through to open new */ }
  }

  if (!resolvedAppName) {
    await enforceMaxTabs(config);
  }

  const bctxId = resolvedAppName ? undefined : sessionRegistry.getBrowserContextIdForAgent(getConfigAgentId(config));
  const metaSession = await CDP({ host: "127.0.0.1", port });
  const { targetId } = await metaSession.Target.createTarget({ url, browserContextId: bctxId });
  await metaSession.close();

  recordTabActivity(targetId);
  await connectToTab(targetId, port, getConfigAgentId(config), bctxId, appName);
  await evaluateTabSemantics(targetId, appName);

  logAction("browser_tabs", url, `opened ${targetId}`);
  return { success: true, tabId: targetId, url };
}

export async function WeavetabSwitch(tabId: string, config: Config, appName?: string): Promise<{ success: true; tab_id: string; title: string; url: string; contextSwitchCostMs: number }> {
  const client = await connectToTab(tabId, undefined, undefined, undefined, appName);
  
  const startSwitch = Date.now();
  await client.session.Target.activateTarget({ targetId: tabId });
  sessionRegistry.setActive(tabId, getConfigAgentId(config), appName);
  recordTabActivity(tabId);

  const { frameTree } = await client.session.Page.getFrameTree();
  let title = tabId;
  try {
    const titleRes = await client.session.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
    if (titleRes?.result?.value) {
      title = titleRes.result.value as string;
    }
  } catch {}
  const url = frameTree.frame.url;

  const cost = Date.now() - startSwitch;
  logAction("browser_tabs", tabId, `switched to ${title} (cost: ${cost}ms)`);
  resetLoopCounter("tab_switch");
  
  return { success: true, tab_id: tabId, title, url, contextSwitchCostMs: cost };
}

export async function WeavetabList(config: Config, appName?: string): Promise<{ tabs: TabInfo[] }> {
  const targets = await getTabList(getConfigAgentId(config), appName);

  const activeTargetId = sessionRegistry.getActive(getConfigAgentId(config), appName)?.targetId;

  const tabs: TabInfo[] = targets
    .map((t: any) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      score: semanticScores.get(t.id) ?? 10,
      health: sessionRegistry.getHealth(t.id),
      status: t.id === activeTargetId
        ? "active"
        : lockedTabIds.has(t.id)
          ? "locked"
          : isIdleTab(t.id, activeTargetId)
            ? "idle"
            : "loading",
    }));

  return { tabs };
}

export async function WeavetabClose(
  tabId: string,
  config: Config,
  force = false,
  appName?: string
): Promise<{ success: true; tab_id: string }> {
  const score = semanticScores.get(tabId) ?? 10;
  if (score >= 70 && !force) {
    throw new Error(`[!] Tab Armor block: This tab is semantically protected (score: ${score}). It likely contains a login, checkout, or critical work. Do not close it! If the user explicitly requested this closure, pass force: true.`);
  }

  const port = resolvePort(config, appName);
  await CDP.Close({ host: "127.0.0.1", port, id: tabId });
  clearTabCache(tabId);
  sessionRegistry.unregister(tabId);
  lastActivityMs.delete(tabId);
  semanticScores.delete(tabId);
  lockedTabIds.delete(tabId);
  logAction("browser_tabs", tabId, "closed");
  return { success: true, tab_id: tabId };
}

/**
 * Batch close multiple tabs at once — saves multiple round-trips.
 */
export async function WeavetabCloseBatch(
  tabIds: string[],
  config: Config,
  force = false,
  appName?: string
): Promise<{ success: true; closed: string[]; skipped: string[] }> {
  const closed: string[] = [];
  const skipped: string[] = [];
  for (const tabId of tabIds) {
    try {
      await WeavetabClose(tabId, config, force, appName);
      closed.push(tabId);
    } catch {
      skipped.push(tabId);
    }
  }
  return { success: true, closed, skipped };
}

/**
 * Consolidate: deduplicate tabs by URL, close duplicates.
 */
export async function WeavetabConsolidate(config: Config, appName?: string): Promise<{
  success: true;
  tabs_before: number;
  tabs_after: number;
  closed_duplicates: number;
}> {
  const port = resolvePort(config, appName);
  const targets = await CDP.List({ host: "127.0.0.1", port });
  const pages = targets.filter((t: any) => t.type === "page" || t.type === "webview" || t.type === "app");
  const tabsBefore = pages.length;

  const seenUrls = new Set<string>();
  let closedDuplicates = 0;
  const activeTargetId = sessionRegistry.getActive(getConfigAgentId(config), appName)?.targetId;

  for (const page of pages) {
    if (page.id === activeTargetId) {
      seenUrls.add(page.url);
      continue;
    }
    if (seenUrls.has(page.url) && page.url !== "about:blank" && page.url !== "") {
      // Duplicate URL — close it
      try {
        await CDP.Close({ host: "127.0.0.1", port, id: page.id });
        clearTabCache(page.id);
        sessionRegistry.unregister(page.id);
        lastActivityMs.delete(page.id);
        semanticScores.delete(page.id);
        lockedTabIds.delete(page.id);
        closedDuplicates++;
      } catch { /* skip */ }
    } else {
      seenUrls.add(page.url);
    }
  }

  const afterTargets = await CDP.List({ host: "127.0.0.1", port });
  const tabsAfter = afterTargets.filter((t: any) => t.type === "page" || t.type === "webview" || t.type === "app").length;

  logAction("browser_tabs", "consolidate", `${tabsBefore}→${tabsAfter} (closed ${closedDuplicates} duplicates)`);
  return { success: true, tabs_before: tabsBefore, tabs_after: tabsAfter, closed_duplicates: closedDuplicates };
}

/**
 * Heal: check all tabs for crashed state and reload them.
 */
export async function WeavetabHeal(config: Config, appName?: string): Promise<{
  success: true;
  healed: number;
  tabs_checked: number;
  health_summary: Record<string, string>;
}> {
  const port = resolvePort(config, appName);
  const targets = await CDP.List({ host: "127.0.0.1", port });
  const pages = targets.filter((t: any) => t.type === "page" || t.type === "webview" || t.type === "app");
  let healed = 0;
  const healthSummary: Record<string, string> = {};

  for (const page of pages) {
    const health = sessionRegistry.getHealth(page.id);
    healthSummary[page.id] = health;

    if (health === "dead") {
      // Dead tab — try reloading via CDP directly
      try {
        const crashSession = await CDP({ host: "127.0.0.1", port, target: page.id });
        await (crashSession as any).Page.reload({ ignoreCache: true });
        await crashSession.close().catch(() => {});
        sessionRegistry.beatHeartbeat(page.id);
        healed++;
      } catch { /* can't heal this one */ }
      continue;
    }

    try {
      const client = await connectToTab(page.id, undefined, undefined, undefined, appName);
      const { result } = await client.session.Runtime.evaluate({
        expression: `document.readyState`,
        returnByValue: true,
      });
      if (!result?.value || result.value === "uninitialized") {
        await client.session.Page.reload({ ignoreCache: true });
        healed++;
      }
    } catch {
      try {
        const crashSession = await CDP({ host: "127.0.0.1", port, target: page.id });
        await (crashSession as any).Page.reload({ ignoreCache: true });
        await crashSession.close().catch(() => {});
        healed++;
      } catch { /* can't heal this one */ }
    }
  }

  logAction("browser_tabs", "heal", `healed ${healed}/${pages.length} tabs`);
  return { success: true, healed, tabs_checked: pages.length, health_summary: healthSummary };
}

// ─── Window management (absorbed from browser_windows) ────────────────────────

export interface WindowInfo {
  windowId: number;
  state: string;
  bounds: { left: number; top: number; width: number; height: number };
  focused: boolean;
}

export async function weaveWindowList(config: Config, appName?: string): Promise<{ windows: WindowInfo[] }> {
  const port = resolvePort(config, appName);
  const targets = await CDP.List({ host: "127.0.0.1", port });
  const pages = targets.filter((t: any) => t.type === "page" || t.type === "webview" || t.type === "app");

  // Group by process — each unique window has its own set of tabs
  // We approximate via CDP Target.getTargets windowId if available
  const windows: WindowInfo[] = [];
  const seenWindowIds = new Set<number>();

  for (const page of pages) {
    try {
      const session = await CDP({ host: "127.0.0.1", port, target: page.id });
      try {
        const { windowId, bounds } = await (session as any).Browser.getWindowForTarget({ targetId: page.id });
        if (!seenWindowIds.has(windowId)) {
          seenWindowIds.add(windowId);
          const activeId = sessionRegistry.getActive(getConfigAgentId(config), appName)?.targetId;
          windows.push({
            windowId,
            state: bounds.windowState || "normal",
            bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
            focused: page.id === activeId,
          });
        }
      } finally {
        await session.close().catch(() => {});
      }
    } catch { /* skip inaccessible targets */ }
  }

  return { windows };
}

export async function weaveFocusWindow(windowId: number, config: Config, appName?: string): Promise<{ success: true; windowId: number }> {
  const port = resolvePort(config, appName);
  const targets = await CDP.List({ host: "127.0.0.1", port });
  const page = targets.find((t: any) => t.type === "page" || t.type === "webview" || t.type === "app");
  if (!page) throw new Error("No page or window target found to focus window");

  const session = await CDP({ host: "127.0.0.1", port, target: page.id });
  try {
    await (session as any).Browser.setWindowBounds({ windowId, bounds: { windowState: "normal" } });
    logAction("browser_tabs", String(windowId), "focused window");
  } finally {
    await session.close().catch(() => {});
  }

  return { success: true, windowId };
}


