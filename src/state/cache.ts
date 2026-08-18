/**
 * Weavetab — state/cache.ts
 * Per-tab action map and box model cache with mutation-based TTL invalidation.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import type { ActionMap } from "../cdp/walker.js";

interface CacheState {
  map: ActionMap | null;
  url: string | null;
  lastReadTime: number;
  lastMutationTime: number;
  boxModels: Map<number, any>; // backendNodeId -> BoxModel
  domNodes: Map<number, any>; // backendNodeId -> Node
}

const tabCache = new Map<string, CacheState>();

export function getCachedActionMap(targetId: string, currentUrl?: string): ActionMap | null {
  const state = tabCache.get(targetId);
  if (!state) return null;
  
  // Ref ID Caching Layer: validity TTL based on DOM mutations
  if (state.lastMutationTime > state.lastReadTime) {
    return null; // Mutated since last read, cache invalid
  }
  
  // URL validation to prevent stale cache across page loads/navigations
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
  const state = tabCache.get(targetId) || { lastMutationTime: 0, lastReadTime: 0, map: null, url: null, boxModels: new Map(), domNodes: new Map() };
  state.map = map;
  state.url = map.url;
  state.lastReadTime = Date.now();
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

// Smarter Idle Detection: Event-driven MutationObserver
// Guard: only register listeners once per CDP session object to prevent
// accumulation when the same session is passed through multiple init paths.
const registeredSessions = new WeakSet<CDP.Client>();

export function registerMutationListener(session: CDP.Client, targetId: string) {
  // Bail out early if this session already has listeners attached.
  // Without this guard, connectToTab + initSession could both call this function
  // for the same session, stacking duplicate listeners that are never removed.
  if (registeredSessions.has(session)) return;
  registeredSessions.add(session);

  let debounceTimer: NodeJS.Timeout | undefined;

  const markMutated = () => {
    // Debounce to avoid flooding the cache invalidation
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      const state = tabCache.get(targetId);
      if (state) {
        state.lastMutationTime = Date.now();
        // Clear box models and dom nodes as they are no longer reliable
        state.boxModels.clear();
        state.domNodes.clear();
      }
    }, 50); // 50ms debounced quiet window
  };

  session.DOM.on("childNodeCountUpdated", markMutated);
  session.DOM.on("attributeModified", markMutated);
  session.DOM.on("characterDataModified", markMutated);
}
