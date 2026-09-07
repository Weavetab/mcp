/**
 * Weavetab — tools/checkpoint.ts
 * browser_checkpoint: Session time-travel and rollback.
 *
 * Captures and restores named checkpoints of browser state:
 *   - Cookies (HttpOnly and Secure via CDP Network)
 *   - LocalStorage & SessionStorage
 *   - URL, page title, and viewport scroll position
 *   - Optional lightweight DOM snapshot
 *
 * Saves tokens and time when trial-and-error automation branches fail.
 *
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { logAction } from "../audit/logger.js";
import { recordAction } from "../intelligence/trail.js";
import { clearTabCache } from "../state/cache.js";
import { sessionRegistry } from "../state/session.js";
import { getConfigAgentId } from "../config/loader.js";

export interface CheckpointData {
  name: string;
  url: string;
  title: string;
  timestamp: string;
  cookies: any[];
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  scroll?: { x: number; y: number };
  domSnapshot?: string;
}

export interface CheckpointArgs {
  action: "save" | "restore" | "list" | "delete";
  name?: string;
  includeDom?: boolean;
}

// In-memory checkpoint registry keyed by targetId -> name -> CheckpointData
const checkpointRegistry = new Map<string, Map<string, CheckpointData>>();

export function getCheckpointsForTarget(targetId: string): Map<string, CheckpointData> {
  let map = checkpointRegistry.get(targetId);
  if (!map) {
    map = new Map<string, CheckpointData>();
    checkpointRegistry.set(targetId, map);
  }
  return map;
}

export function clearAllCheckpoints(): void {
  checkpointRegistry.clear();
}

export async function browserCheckpoint(
  session: CDP.Client,
  args: CheckpointArgs,
  config: Config
): Promise<any> {
  let targetId = "default";
  const active = sessionRegistry.getActive(getConfigAgentId(config));
  if (active) targetId = active.targetId;

  const targetCheckpoints = getCheckpointsForTarget(targetId);

  // ── ACTION: LIST ─────────────────────────────────────────────────────────────
  if (args.action === "list") {
    const list = Array.from(targetCheckpoints.values()).map((cp) => ({
      name: cp.name,
      url: cp.url,
      title: cp.title,
      timestamp: cp.timestamp,
      cookiesCount: cp.cookies.length,
      localStorageKeys: Object.keys(cp.localStorage).length,
      sessionStorageKeys: Object.keys(cp.sessionStorage).length,
      hasDomSnapshot: !!cp.domSnapshot,
    }));
    return {
      success: true,
      action: "list",
      count: list.length,
      checkpoints: list,
    };
  }

  // ── ACTION: DELETE ───────────────────────────────────────────────────────────
  if (args.action === "delete") {
    if (!args.name) {
      return {
        success: false,
        error_code: "INVALID_ARGS",
        message: "Checkpoint 'name' is required for action 'delete'.",
      };
    }
    const existed = targetCheckpoints.delete(args.name);
    return {
      success: existed,
      action: "delete",
      name: args.name,
      message: existed
        ? `Checkpoint '${args.name}' deleted successfully.`
        : `Checkpoint '${args.name}' not found.`,
    };
  }

  // ── ACTION: SAVE ─────────────────────────────────────────────────────────────
  if (args.action === "save") {
    if (!args.name) {
      return {
        success: false,
        error_code: "INVALID_ARGS",
        message: "Checkpoint 'name' is required for action 'save'.",
      };
    }

    const { Page, Network, Runtime } = session;
    const { frameTree } = await Page.getFrameTree();
    const currentUrl = frameTree.frame.url;

    // 1. Snapshot cookies
    let cookies: any[] = [];
    try {
      if (typeof Network.getCookies === "function") {
        const res = await Network.getCookies({ urls: [currentUrl] });
        cookies = res.cookies || [];
      } else if (typeof Network.getAllCookies === "function") {
        const res = await Network.getAllCookies();
        cookies = res.cookies || [];
      }
    } catch {
      // Cookies best-effort
    }

    // 2. Snapshot LocalStorage, SessionStorage, Scroll, and Title
    let storageData: {
      localStorage: Record<string, string>;
      sessionStorage: Record<string, string>;
      scroll: { x: number; y: number };
      title: string;
    } = {
      localStorage: {},
      sessionStorage: {},
      scroll: { x: 0, y: 0 },
      title: "",
    };

    try {
      const evalRes = await Runtime.evaluate({
        expression: `(function() {
          var ls = {};
          try {
            for (var i = 0; i < localStorage.length; i++) {
              var k = localStorage.key(i);
              if (k) ls[k] = localStorage.getItem(k);
            }
          } catch(e) {}
          var ss = {};
          try {
            for (var j = 0; j < sessionStorage.length; j++) {
              var sk = sessionStorage.key(j);
              if (sk) ss[sk] = sessionStorage.getItem(sk);
            }
          } catch(e) {}
          return {
            localStorage: ls,
            sessionStorage: ss,
            scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
            title: document.title || ""
          };
        })()`,
        returnByValue: true,
      });
      if (evalRes?.result?.value) {
        storageData = evalRes.result.value;
      }
    } catch {
      // Runtime best-effort
    }

    // 3. Optional lightweight DOM capture
    let domSnapshot: string | undefined;
    if (args.includeDom) {
      try {
        const domRes = await Runtime.evaluate({
          expression: `document.documentElement.outerHTML.slice(0, 100000)`,
          returnByValue: true,
        });
        domSnapshot = domRes?.result?.value;
      } catch {
        // ignore
      }
    }

    const checkpoint: CheckpointData = {
      name: args.name,
      url: currentUrl,
      title: storageData.title,
      timestamp: new Date().toISOString(),
      cookies,
      localStorage: storageData.localStorage,
      sessionStorage: storageData.sessionStorage,
      scroll: storageData.scroll,
      domSnapshot,
    };

    targetCheckpoints.set(args.name, checkpoint);

    logAction("browser_checkpoint", args.name, `Saved checkpoint at ${currentUrl}`);
    recordAction({
      timestamp: checkpoint.timestamp,
      tool: "browser_checkpoint",
      input: { action: "save", name: args.name, url: currentUrl },
      result: { success: true },
    });

    return {
      success: true,
      action: "save",
      name: args.name,
      url: currentUrl,
      title: storageData.title,
      timestamp: checkpoint.timestamp,
      cookiesCount: cookies.length,
      localStorageKeysCount: Object.keys(storageData.localStorage).length,
      sessionStorageKeysCount: Object.keys(storageData.sessionStorage).length,
    };
  }

  // ── ACTION: RESTORE ──────────────────────────────────────────────────────────
  if (args.action === "restore") {
    if (!args.name) {
      return {
        success: false,
        error_code: "INVALID_ARGS",
        message: "Checkpoint 'name' is required for action 'restore'.",
      };
    }

    const checkpoint = targetCheckpoints.get(args.name);
    if (!checkpoint) {
      return {
        success: false,
        error_code: "CHECKPOINT_NOT_FOUND",
        message: `No checkpoint found with name '${args.name}'. Use action: 'list' to see available checkpoints.`,
      };
    }

    const { Page, Network, Runtime } = session;
    const { frameTree } = await Page.getFrameTree();
    const currentUrl = frameTree.frame.url;

    // 1. Navigate to checkpoint URL if different
    if (currentUrl !== checkpoint.url) {
      await Page.navigate({ url: checkpoint.url });
      await Page.loadEventFired().catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
    }

    // 2. Restore Cookies
    if (checkpoint.cookies && checkpoint.cookies.length > 0) {
      try {
        if (typeof Network.setCookies === "function") {
          await Network.setCookies({ cookies: checkpoint.cookies });
        }
      } catch {
        // Cookies best-effort
      }
    }

    // 3. Restore LocalStorage, SessionStorage, and Scroll position
    try {
      await Runtime.evaluate({
        expression: `(function(ls, ss, scroll) {
          try {
            localStorage.clear();
            for (var k in ls) { localStorage.setItem(k, ls[k]); }
          } catch(e) {}
          try {
            sessionStorage.clear();
            for (var sk in ss) { sessionStorage.setItem(sk, ss[sk]); }
          } catch(e) {}
          if (scroll) {
            window.scrollTo(scroll.x, scroll.y);
          }
        })(${JSON.stringify(checkpoint.localStorage)}, ${JSON.stringify(
          checkpoint.sessionStorage
        )}, ${JSON.stringify(checkpoint.scroll)})`,
        returnByValue: false,
      });
    } catch {
      // Storage best-effort
    }

    // Invalidate cached action map for this target so fresh refs get generated
    clearTabCache(targetId);

    logAction("browser_checkpoint", args.name, `Restored checkpoint to ${checkpoint.url}`);
    recordAction({
      timestamp: new Date().toISOString(),
      tool: "browser_checkpoint",
      input: { action: "restore", name: args.name, targetUrl: checkpoint.url },
      result: { success: true },
    });

    return {
      success: true,
      action: "restore",
      name: args.name,
      url: checkpoint.url,
      title: checkpoint.title,
      restoredTimestamp: checkpoint.timestamp,
    };
  }

  return {
    success: false,
    error_code: "INVALID_ACTION",
    message: `Unsupported action '${(args as any).action}'. Supported actions: save, restore, list, delete.`,
  };
}
