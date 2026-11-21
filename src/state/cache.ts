import CDP from "chrome-remote-interface";
import type { ActionMap } from "../cdp/walker.js";

interface CacheState {
  map: ActionMap | null;
  url: string | null;
  lastReadTime: number;
  lastMutationTime: number;
  boxModels: Map<number, any>;
  domNodes: Map<number, any>;
}

const tabCache = new Map<string, CacheState>();

export function getCachedActionMap(targetId: string, currentUrl?: string): ActionMap | null {
  const state = tabCache.get(targetId);
  if (!state) return null;

  if (state.lastMutationTime > state.lastReadTime) {
    return null;
  }

  if (currentUrl && state.map && state.map.url !== currentUrl) {
    return null;
  }
  return state.map;
}

export function getRawCachedActionMap(targetId: string, currentUrl?: string): ActionMap | null {
  const state = tabCache.get(targetId);
  if (!state) return null;

  if (currentUrl && state.map && state.map.url !== currentUrl) {
    return null;
  }
  return state.map;
}

export function cacheActionMap(targetId: string, map: ActionMap) {
  const state = tabCache.get(targetId) || {
    lastMutationTime: 0,
    lastReadTime: 0,
    map: null,
    url: null,
    boxModels: new Map(),
    domNodes: new Map(),
  };
  state.map = map;
  state.url = map.url;
  state.lastReadTime = Date.now();
  state.boxModels.clear();
  state.domNodes.clear();
  tabCache.set(targetId, state);
}

export function cacheBoxModel(targetId: string, backendNodeId: number, boxModel: any) {
  const state = tabCache.get(targetId);
  if (state) state.boxModels.set(backendNodeId, boxModel);
}

export function getCachedBoxModel(targetId: string, backendNodeId: number): any | null {
  const state = tabCache.get(targetId);
  if (!state || state.lastMutationTime > state.lastReadTime) return null;
  return state.boxModels.get(backendNodeId) || null;
}

export function cacheNode(targetId: string, backendNodeId: number, node: any) {
  const state = tabCache.get(targetId);
  if (state) state.domNodes.set(backendNodeId, node);
}

export function getCachedNode(targetId: string, backendNodeId: number): any | null {
  const state = tabCache.get(targetId);
  if (!state || state.lastMutationTime > state.lastReadTime) return null;
  return state.domNodes.get(backendNodeId) || null;
}

export function clearTabCache(targetId: string) {
  tabCache.delete(targetId);
}

const sessionUnsubs = new WeakMap<CDP.Client, Array<() => void>>();

export function registerMutationListener(session: CDP.Client, targetId: string) {
  if (sessionUnsubs.has(session)) return;

  const unsubs: Array<() => void> = [];
  sessionUnsubs.set(session, unsubs);

  let debounceTimer: NodeJS.Timeout | undefined;

  const invalidateNow = () => {
    const state = tabCache.get(targetId);
    if (state) {
      state.lastMutationTime = Math.max(Date.now(), state.lastReadTime + 1);
      state.boxModels.clear();
      state.domNodes.clear();
    }
  };

  const markMutated = () => {
    invalidateNow();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      invalidateNow();
    }, 50);
    debounceTimer.unref?.();
  };

  const events = [
    "childNodeCountUpdated",
    "attributeModified",
    "characterDataModified",
    "documentUpdated",
    "childNodeInserted",
    "childNodeRemoved",
    "attributeRemoved",
  ] as const;

  const dom: any = session.DOM;
  if (!dom) return;

  for (const ev of events) {
    const ret =
      typeof dom.on === "function"
        ? dom.on(ev, markMutated)
        : typeof dom[ev] === "function"
        ? dom[ev](markMutated)
        : undefined;
    if (typeof ret === "function") {
      unsubs.push(ret);
    } else if (typeof dom.removeListener === "function") {
      unsubs.push(() => dom.removeListener(ev, markMutated));
    }
  }
}
