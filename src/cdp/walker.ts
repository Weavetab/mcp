import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — cdp/walker.ts
 * Accessibility tree walker: builds w:N ref IDs, viewport culling, and heuristic pointer sweep.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import { filterHidden } from "../security/filter.js";
import { SessionSecretTracker } from "../security/secrets.js";
import type { RefEntry } from "../state/delta.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export const WT_REGISTRY_INIT_EXPR = `
  window.__weavetab = window.__weavetab || {};
  window.__weavetab.registry = window.__weavetab.registry || new WeakMap();
`;

export type HrefType =
  | "same-origin" | "external" | "anchor" | "email" | "unknown";

export interface ActionElement {
  id: string;           // "w:42" — Rule 8
  role: string;
  label: string;
  value?: string;
  backendNodeId?: number;
  selector?: string;    // Stable CSS selector for extension coordination
  group: "navigation" | "main_content" | "sidebar" | "form" | "modal" | "utility";
  type?: string;
  href?: string;
  hrefType?: HrefType;
  placeholder?: string;
  testId?: string;
  textContent?: string; // visible text content for delta diffing (Phase 5e)
  className?: string;   // class attribute for tracking CSS changes (Phase 5e)
  frameUrl?: string;    // origin URL of iframe containing this element (if any)
  fingerprint: string;  // "button:sign-in:form:3" — used for cache + delta
  isFixed?: boolean;    // for position:fixed/sticky elements (never culled)
  disabled?: boolean;   // true when element is aria-disabled or disabled attr
  depth: number;
  x?: number;
  y?: number;
  viewport?: string;
  structuralIdiom?: string; // Captured structural hints (e.g. "aria-controls")
}


export interface ActionMap {
  url: string;
  title: string;
  elements: ActionElement[];
  pageType?: string;
  targetId?: string;
  domHash?: number;
}

export interface WalkerOptions {
  scope?: ActionElement["group"];
  query?: string;
  limit?: number;
  lite?: boolean;
  fast?: boolean;
  /** If true, returns delta info instead of full element list (caller handles) */
  forDelta?: boolean;
  /** Viewport dimensions — used for culling. Defaults fetched from browser if not passed. */
  viewport?: { width: number; height: number; scrollX: number; scrollY: number };
  /** If true, skip the flat-first optimization and go straight to deep shadow DOM traversal */
  deep?: boolean;
  /** Pre-resolved page URL — avoids redundant Page.getFrameTree() call */
  url?: string;
  /** Pre-resolved page title */
  title?: string;
  /**
   * If true, run semantic DOM pruning before returning elements.
   * Drops hidden elements with no interactive descendants and no known toggle-trigger.
   * Replaces SVG icons with [SVG Icon: label] tokens.
   * NOTE: distinct from delta (which diffs across time). Pruning compresses the
   * current snapshot once, before it is returned.
   */
  prune?: boolean;
}

// ─── Viewport info ────────────────────────────────────────────────────────────

interface Viewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

const viewportCache = new Map<string, Viewport>();

export function clearViewportCache(targetId: string) {
  viewportCache.delete(targetId);
}

// ─── Per-navigation fallback ID counter (legacy — kept for external callers) ──
// NOTE: This counter is NO LONGER used for collision dedup — see walkPassGlobalRefCounter.
// Kept only so callers of resetFallbackIdCounter() don't break.
let wtFallbackIdCounter = 1;

export function resetFallbackIdCounter(): void {
  wtFallbackIdCounter = 1;
}

// ─── Global atomic walk-pass ref counter (Bug #5 fix) ────────────────────────
// A single monotonically-incrementing integer shared across ALL walk passes,
// ALL frames, ALL tabs, and ALL tools in the process lifetime.
// It is NEVER reset — only ever incremented — so no two elements across any
// code path can ever receive the same numeric suffix in their ref ID.
//
// Design invariants:
//   • walkPassGlobalRefCounter ticks forward on every fallback ID assignment.
//   • walkPassSeenIds is the authoritative dedup registry for one top-level
//     buildActionMap / buildAXTreeMap call (cross-frame scope).
//   • beginWalkPass() is called ONCE at the top of each public entry point.
//   • The JS collision counter injected into in-page code is seeded with
//     walkPassGlobalRefCounter so iframe B's counter starts where iframe A ended.
let walkPassGlobalRefCounter = 1;
let walkPassSeenIds = new Map<string, number>();

/**
 * Must be called at the start of every buildActionMap / buildAXTreeMap
 * invocation.  Returns the counter base captured for this pass so the
 * in-page JS can be seeded with it.
 */
function beginWalkPass(): number {
  walkPassSeenIds = new Map<string, number>();
  return walkPassGlobalRefCounter;
}

/**
 * Reserves the next N IDs from the global counter and returns the first.
 * Thread-safe within a single Node.js event-loop tick (synchronous).
 */
function allocateRefIds(count: number): number {
  const base = walkPassGlobalRefCounter;
  walkPassGlobalRefCounter += Math.max(count, 1);
  return base;
}

/**
 * Deduplicates a ref ID within the current walk pass (cross-frame scope).
 * If `id` is already taken, appends _2, _3, … until unique, then records it.
 * Uses walkPassSeenIds so collisions from different iframes are caught.
 */
function dedupeRefId(id: string): string {
  if (!walkPassSeenIds.has(id)) {
    walkPassSeenIds.set(id, 1);
    return id;
  }
  const next = walkPassSeenIds.get(id)! + 1;
  walkPassSeenIds.set(id, next);
  // Append _N suffix; recursively check in case _N itself is taken
  return dedupeRefId(`${id}_${next}`);
}

// ─── Shadow DOM reference cache (Phase 2a) ───────────────────────────────────
// Caches whether a page has discovered shadow DOM content per targetId.
// Avoids the overhead of a two-phase (flat → deep) query on every browser_map.
const shadowDomCache = new Map<string, boolean>();

export function setShadowDomCache(targetId: string, hasShadow: boolean): void {
  shadowDomCache.set(targetId, hasShadow);
}

export function clearShadowDomCache(targetId: string): void {
  shadowDomCache.delete(targetId);
}

// ─── Main walker ─────────────────────────────────────────────────────────────

// Shared helper that identifies WeaveTab's own overlay/UI elements.
// Applied in both buildActionMap (DOM walker path) and buildAXTreeMap (AX tree
// path) so overlay elements never appear in delta output regardless of code path.
function isWeaveTabOverlay(label?: string, selector?: string): boolean {
  const lbl = label?.toLowerCase().trim() || '';
  const sel = selector?.toLowerCase() || '';
  const WT_LABELS = new Set([
    'chat with weavetab', 'weavetab', 'wt-msg-input', 'wt-msg-send',
    'wt-msg-panel', 'wt-ghost-cursor', 'wt-ghost-bubble', 'weavetab-tactical-overlay',
    'wt-shadow-host', 'wt-chat-icon', 'wt-chat-panel', 'wt-chat-input',
    'f3', 'toggle theme', 'minimize', 'send feedback...'
  ]);
  if (WT_LABELS.has(lbl)) return true;
  if (/^(chat with weavetab|weavetab hud|weave.*tab.*chat|send feedback|redirect, add a note, change goal|\u2191$|wt-(chat|shadow))/i.test(lbl)) return true;
  if (sel.includes('wt-shadow') || sel.includes('data-wt-ignore') || sel.startsWith('#wt-')) return true;
  return false;
}

export async function buildActionMap(
  session: CDP.Client,
  options: WalkerOptions = {},
  targetId = "default"
): Promise<ActionMap> {
  // ── Begin a new walk pass — resets per-pass dedup registry ─────────────────
  const passCounterBase = beginWalkPass();
  const url = options.url ?? (await session.Page.getFrameTree()).frameTree.frame.url;
  const title = options.title ?? "";

  // Inherit sticky pruning state from session if not explicitly set in options
  if (options.prune === undefined) {
    const { sessionRegistry } = await import("../state/session.js");
    const client = sessionRegistry.getAll().find(c => c.targetId === targetId);
    if (client?.pruneActive) {
      options.prune = true;
    }
  }

  const { getFromExtension } = await import("./helpers.js");
  let extensionMap = await getFromExtension(session, { type: 'GET_SEMANTIC_MAP' });

  // Validate the extension result — reject if any element has undefined ID
  if (extensionMap && Array.isArray(extensionMap)) {
    const invalidCount = extensionMap.filter(
      (el: any) => el.id === undefined || el.id === null || el.id === ''
    ).length;
    if (invalidCount > 0) {
      logDebug(`[Walker] Extension returned ${invalidCount}/${extensionMap.length} elements with invalid IDs, forcing CDP fallback`);
      extensionMap = null;
    }
  }

  // Phase 0.2: DOM ID verification — confirm extension IDs are actually written as
  // data-wt-id attributes in the live DOM. If the majority are missing the extension
  // built a map but never applied the attributes; fall through to CDP fallback.
  if (extensionMap && Array.isArray(extensionMap) && extensionMap.length > 0) {
    const sampleSize = Math.min(5, extensionMap.length);
    const sampleIds = (extensionMap as any[]).slice(0, sampleSize).map((el: any) => el.id).filter(Boolean);
    if (sampleIds.length > 0) {
      try {
        const { result: domVerify } = await session.Runtime.evaluate({
          expression: `(function(ids) {
            return ids.filter(function(id) {
              return !document.querySelector('[data-wt-id="' + id + '"]');
            }).length;
          })(${JSON.stringify(sampleIds)})`,
          returnByValue: true
        });
        const missingCount = (domVerify?.value as number) ?? sampleIds.length;
        if (missingCount > Math.ceil(sampleIds.length / 2)) {
          logDebug(`[Walker] Extension ID DOM verification: ${missingCount}/${sampleIds.length} IDs not found in DOM \u2014 falling through to CDP fallback`);
          extensionMap = null;
        }
      } catch { /* non-fatal \u2014 keep extensionMap as-is and proceed */ }
    }
  }

  
  if (!extensionMap || !Array.isArray(extensionMap)) {
    // Architecture change: Try to read from extension's live index first
    // The extension now maintains window.__wt_liveIndex via continuous MutationObserver
    const { result: liveIndexResult } = await session.Runtime.evaluate({
      expression: `(function() {
        if (typeof window.__wt_liveIndex !== 'undefined' && Array.isArray(window.__wt_liveIndex)) {
          return JSON.stringify({ 
            elements: window.__wt_liveIndex,
            source: 'live-index'
          });
        }
        return JSON.stringify({ elements: null, source: 'unavailable' });
      })()`,
      returnByValue: true
    });

    if (liveIndexResult && liveIndexResult.value) {
      try {
        const parsed = JSON.parse(liveIndexResult.value as string);
        if (parsed.source === 'live-index' && parsed.elements && Array.isArray(parsed.elements)) {
          logDebug(`[Walker] Successfully read ${parsed.elements.length} elements from extension live index`);
          extensionMap = parsed.elements;
        }
      } catch (e) {
        logDebug(`[Walker] Failed to parse live index result: ${e}`);
      }
    }
  }

  if (!extensionMap || !Array.isArray(extensionMap)) {
    // Fallback: inject a script to get interactable elements when extension is missing
    // Hardened with per-element try-catch — one bad node no longer kills the entire map
    // Deep shadow DOM traversal — falls back to recursive shadow-penetrating query when flat query is sparse
    const { result } = await session.Runtime.evaluate({
      expression: `(function() {
        var INTERACTIVE_SEL = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])';

        // deepQuery has a hard depth limit and a visited-set guard so circular
        // shadow root references can't cause a stack overflow.
        function deepQuery(root, selector, visited, depth) {
          if (!visited) visited = new Set();
          if (depth === undefined) depth = 0;
          if (depth > 10) return [];  // hard depth limit
          if (visited.has(root)) return [];  // break cycles
          visited.add(root);
          var all = [];
          try {
            var direct = root.querySelectorAll(selector);
            for (var i = 0; i < direct.length; i++) all.push(direct[i]);
          } catch (e) {}
          // TreeWalker — lazy DOM traversal, avoids building a static NodeList of every element
          try {
            var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
            while (walker.nextNode()) {
              try {
                var el = walker.currentNode;
                if (el.shadowRoot && !visited.has(el.shadowRoot)) {
                  var inner = deepQuery(el.shadowRoot, selector, visited, depth + 1);
                  for (var k = 0; k < inner.length; k++) all.push(inner[k]);
                }
              } catch (e) {}
            }
          } catch (e) {}
          return all;
        }

        var hasShadowCache = ${JSON.stringify(!!shadowDomCache.get(targetId))};
        var useDeep = ${JSON.stringify(!!(options as any).deep)} || hasShadowCache;
        var els = [];

        // Phase 1: flat query (skip when cache confirms shadow DOM exists — deepQuery covers root too)
        if (!hasShadowCache) {
          try {
            var flatEls = document.querySelectorAll(INTERACTIVE_SEL);
            for (var fi = 0; fi < flatEls.length; fi++) els.push(flatEls[fi]);
          } catch (e) {}
        }

        // Phase 2: deep query if cache hit OR flat results are sparse
        if (useDeep || els.length < 3) {
          try {
            var deepEls = deepQuery(document, INTERACTIVE_SEL);
            // Deduplicate by comparing tagName + label + position fingerprint
            var seen = new Set();
            for (var di = 0; di < els.length; di++) {
              try {
                var r = els[di].getBoundingClientRect();
                seen.add(els[di].tagName + '|' + Math.round(r.left) + '|' + Math.round(r.top));
              } catch (e) {}
            }
            for (var di2 = 0; di2 < deepEls.length; di2++) {
              try {
                var el2 = deepEls[di2];
                var r2 = el2.getBoundingClientRect();
                var key = el2.tagName + '|' + Math.round(r2.left) + '|' + Math.round(r2.top);
                if (!seen.has(key)) {
                  els.push(el2);
                  seen.add(key);
                }
              } catch (e) {}
            }
          } catch (e) {}
        }

        // ── Content-addressable IDs — stable across re-renders ────────────────
        // djb2 hash of (tagName + role + trimmed text/label + sibling-index + parent context).
        // Same element always gets the same ID even if the walker runs multiple
        // times. Sequential counter only used as collision fallback.
        function wtHashId(el) {
          var tag = el.tagName || '';
          var role = el.getAttribute('role') || '';
          var text = (el.getAttribute('aria-label') || el.textContent || el.value || el.placeholder || '').slice(0, 60).trim();
          var rect = el.getBoundingClientRect();
          var absX = Math.round(rect.left + (window.scrollX || 0));
          var absY = Math.round(rect.top + (window.scrollY || 0));
          var path = '';
          try {
            var curr = el;
            for(var level = 0; level < 3 && curr; level++) {
                var p = curr.parentElement;
                if (!p) break;
                var idx = 0;
                var siblings = p.children;
                for (var si = 0; si < siblings.length; si++) {
                  if (siblings[si] === curr) { idx = si; break; }
                }
                path += '|' + (curr.tagName||'') + '[' + idx + ']';
                curr = p;
            }
          } catch(e) {}
          var raw = tag + '|' + role + '|' + text + '|' + absX + '|' + absY + path;
          var h = 5381;
          for (var ci = 0; ci < raw.length; ci++) {
            h = ((h << 5) + h) ^ raw.charCodeAt(ci);
            h = h >>> 0; // keep unsigned 32-bit
          }
          return 'wt' + h.toString(36);
        }
        var usedHashes = {};
        // Bug #5 fix: seed collision counter from the global walk-pass base so that
        // elements in different iframes processed in the same pass never share a
        // numeric suffix.  passCounterBase is injected by the TypeScript host.
        var collisionCounter = ${JSON.stringify(passCounterBase)};
        var _coIdx = 0;
        var results = [];
        for (var i2 = 0; i2 < els.length; i2++) {
          try {
            var el = els[i2];
            if (el.closest('[data-wt-ignore]') !== null) continue;
            var rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
            var id = el.getAttribute('data-wt-id');
            if (!id) {
              var hid = wtHashId(el);
              // Resolve collision: if same hash already used, append counter
              if (usedHashes[hid]) {
                hid = hid + '_' + (collisionCounter++);
              }
              usedHashes[hid] = true;
              id = hid;
              el.setAttribute('data-wt-id', id);
            }
            var role = el.tagName.toLowerCase();
            if (role === 'a') role = 'link';
            else if (role === 'input' && (el.type === 'text' || el.type === 'search')) role = 'textbox';
            var frameUrl = '';
            try { if (el.ownerDocument !== document) frameUrl = el.ownerDocument.defaultView.location.href; } catch(e) { frameUrl = 'cross-origin-' + (_coIdx++); }
            var isSecret = el.hasAttribute('data-wt-secret') || (el.tagName === 'INPUT' && el.type === 'password');
            var labelStr = el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || '';
            // For radio/checkbox, serialize checked state as 'true'/'false' so the agent
            // can see which option is selected without having to scrape the DOM separately.
            var elType = (el.type || '').toLowerCase();
            var elRole = (el.getAttribute('role') || el.tagName.toLowerCase());
            var isCheckable = elType === 'radio' || elType === 'checkbox' ||
                              elRole === 'radio' || elRole === 'checkbox';
            var isOption   = el.tagName === 'OPTION';
            var valStr;
            if (isCheckable) {
              valStr = el.checked ? 'true' : 'false';
            } else if (isOption) {
              valStr = el.selected ? 'true' : 'false';
            } else {
              valStr = el.value !== undefined ? String(el.value) : undefined;
            }
            var txtContent = (el.textContent || '').slice(0, 200);

            if (isSecret) {
              var rawAria = el.getAttribute('aria-label') || '';
              var rawPlaceholder = el.placeholder || '';
              labelStr = rawAria || rawPlaceholder || '[REDACTED SECRET FIELD]';
              if (valStr !== undefined) valStr = '[REDACTED]';
              txtContent = '[REDACTED]';
            }

            // Capture structural idiom (e.g. aria-controls, aria-owns, etc.)
            var idiom = '';
            var CONTROLS_ATTRS = ['aria-controls', 'aria-owns', 'data-target', 'data-bs-target'];
            for (var ca = 0; ca < CONTROLS_ATTRS.length; ca++) {
              if (el.hasAttribute(CONTROLS_ATTRS[ca])) {
                idiom = CONTROLS_ATTRS[ca];
                break;
              }
            }
            results.push({
              id: String(id),
              role: el.getAttribute('role') || role,
              label: labelStr,
              value: valStr,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              selector: '[data-wt-id="' + id + '"]',
              href: el.href,
              textContent: txtContent,
              className: el.className || '',
              frameUrl: frameUrl,
              structuralIdiom: idiom || undefined
            });
          } catch (e) {
            // Silently skip elements that cause errors (cross-origin SVG, detached nodes, etc.)
          }
        }
        return JSON.stringify({ elements: results, shadowFound: results.length > 0 && typeof flatEls !== 'undefined' && els.length > flatEls.length });
      })()`,
      returnByValue: true
    });
    if (result && result.value) {
      try {
        var parsed = JSON.parse(result.value as string);
        // New format: { elements: [...], shadowFound: boolean }
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.elements) {
          extensionMap = parsed.elements;
          if (parsed.shadowFound) {
            shadowDomCache.set(targetId, true);
          }
        } else {
          // Old format: bare array
          extensionMap = parsed;
        }
      } catch (e) {
        extensionMap = [];
      }
    }
  }

  // Merge elements from child webviews and iframes managed by OmniBroker
  try {
    const { getOmniSessions } = await import("./omni_broker.js");
    const childSessions = getOmniSessions(targetId);
    if (childSessions && childSessions.size > 0) {
      for (const [, childSession] of childSessions.entries()) {
        try {
          const { result: childResult } = await childSession.Runtime.evaluate({
            expression: `(function() {
              var INTERACTIVE_SEL = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"], [role="menuitem"], [role="tab"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
              var els = document.querySelectorAll(INTERACTIVE_SEL);
              var results = [];
              for (var i = 0; i < els.length; i++) {
                var el = els[i];
                var rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
                var id = el.getAttribute('data-wt-id');
                if (!id) {
                  id = 'wv_' + Math.random().toString(36).slice(2, 9);
                  el.setAttribute('data-wt-id', id);
                }
                results.push({
                  id: id,
                  role: el.getAttribute('role') || el.tagName.toLowerCase(),
                  label: el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || '',
                  value: el.value,
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2),
                  selector: '[data-wt-id="' + id + '"]',
                  frameUrl: window.location.href,
                });
              }
              return JSON.stringify(results);
            })()`,
            returnByValue: true,
          });
          if (childResult && childResult.value) {
            const childEls = JSON.parse(childResult.value as string);
            if (Array.isArray(childEls) && childEls.length > 0) {
              if (!Array.isArray(extensionMap)) extensionMap = [];
              extensionMap = extensionMap.concat(childEls);
            }
          }
        } catch {}
      }
    }
  } catch {}

  if (!extensionMap || !Array.isArray(extensionMap)) {
    return { url, title, elements: [], targetId };
  }

  // Accept both extension format ({tag, text, coords}) and fallback format ({role, label, x, y})
  const mappedElements: ActionElement[] = extensionMap.map((el: any) => ({
    id: `w:${el.id}`,
    role: el.role || el.tag || 'generic',
    label: el.label || el.text || el.placeholder || '',
    value: el.value,
    group: 'main_content',
    fingerprint: `${el.role || el.tag || 'generic'}:${el.label || el.text || ''}:${el.id}`,
    depth: 0,
    x: el.x ?? (el.coords ? el.coords.x : undefined),
    y: el.y ?? (el.coords ? el.coords.y : undefined),
    viewport: el.viewport,
    href: el.href,
    selector: el.selector,
    backendNodeId: undefined,
    textContent: el.textContent || undefined,
    className: el.className || el.attributes?.class || '',
    structuralIdiom: el.structuralIdiom || undefined,
    frameUrl: el.frameUrl || undefined,
  }));

  // Post-mapping sanitizer — catch any w:undefined/w:null and reassign.
  // Uses a stable hash derived from the element's fingerprint, coordinates, and
  // index rather than an incrementing global counter (which would yield unstable
  // IDs across map calls).
  let invalidIdCount = 0;
  const usedFallbackHashes = new Set<string>();
  for (let i = 0; i < mappedElements.length; i++) {
    if (!mappedElements[i].id || mappedElements[i].id === 'w:undefined' || mappedElements[i].id === 'w:null' || mappedElements[i].id === 'w:') {
      const baseStr = `${mappedElements[i].role}|${mappedElements[i].label}|${mappedElements[i].x}|${mappedElements[i].y}`;
      let h = 5381;
      for (let c = 0; c < baseStr.length; c++) { h = ((h << 5) + h) ^ baseStr.charCodeAt(c); h = h >>> 0; }
      let hash = h.toString(36);
      if (usedFallbackHashes.has(hash)) {
        let col = 1;
        while (usedFallbackHashes.has(`${hash}_${col}`)) col++;
        hash = `${hash}_${col}`;
      }
      usedFallbackHashes.add(hash);
      mappedElements[i].id = `w:f${hash}`; // 'f' for fallback
      mappedElements[i].fingerprint = `${mappedElements[i].role}:${mappedElements[i].label}:fb-${hash}`;
      invalidIdCount++;
    }
  }
  if (invalidIdCount > 0) {
    logDebug(`[Walker] Post-mapping sanitizer fixed ${invalidIdCount} element(s) with stable fallback IDs`);
  }

  // ── Bug #5 fix: global cross-frame dedup using walkPassSeenIds ───────────────
  // walkPassSeenIds is reset once per buildActionMap call (see beginWalkPass()).
  // It spans ALL frames in this pass — not just this mappedElements array — so a
  // hash collision between an element in the main frame and one in an iframe is
  // caught and disambiguated here rather than silently producing two `w:X` refs.
  {
    for (const el of mappedElements) {
      const original = el.id;
      const deduped = dedupeRefId(el.id);
      if (deduped !== original) {
        el.id = deduped;
        // Patch data-wt-id selector so click/type tools can still resolve the element.
        if (el.selector && el.selector.includes('data-wt-id')) {
          el.selector = el.selector.replace(/data-wt-id="[^"]+"/, `data-wt-id="${el.id.replace('w:', '')}"`);
        }
        logDebug(`[Walker] Bug#5 cross-frame dedup: ${original} → ${el.id}`);
      }
    }
  }

  // ── AI-blind: strip Weavetab overlay elements from the map ─────────────────
  // The chat panel, ghost cursor, HUD, and overlay UI are for the USER only.
  // The AI must never see, click, or type into them.
  // Uses shared isWeaveTabOverlay() helper — also applied in buildAXTreeMap.

  const visibleElements = mappedElements.filter((el) => {
    // Use shared isWeaveTabOverlay helper for consistent filtering
    if (isWeaveTabOverlay(el.label, el.selector)) return false;
    // Defense-in-depth: skip elements with empty labels and non-interactive roles
    // Catches overlay elements that slipped through (e.g. plain divs with onclick)
    const lbl = el.label?.toLowerCase().trim() || '';
    if (!lbl && !el.value && !el.placeholder && !el.href &&
        (el.role === 'generic' || el.role === '' || el.role === 'div')) return false;
    return true;
  });
  // ──────────────────────────────────────────────────────────────────────────

  // ── Semantic DOM Pruning (optional, opt-in via prune:true) ─────────────────
  // Prune = one-shot compression of THIS snapshot before returning.
  // Delta = diffs across time (previous call → now). They are complementary.
  // NOTE: sequenced after data-wt-id assignment. Do not enable
  // as default until that approach is confirmed stable.
  let prunedElements = visibleElements;
  if (options.prune) {
    try {
      const { loadDomainProfile } = await import('../intelligence/sessionMemory.js');
      const hostname = new URL(url).hostname;
      const profile = await loadDomainProfile(hostname);
      const structuralIdioms = profile?.memories
        .filter(m => m.state !== "deprecated" && m.fingerprint?.structuralIdiom)
        .map(m => m.fingerprint!.structuralIdiom!) || [];
      
      // Deduplicate idioms
      const uniqueIdioms = Array.from(new Set(structuralIdioms));

      const { pruneSnapshot } = await import('./pruner.js');
      prunedElements = await pruneSnapshot(session, visibleElements, targetId, uniqueIdioms);
    } catch (e) {
      logDebug(`[Walker] Pruner threw — falling back to unpruned list: ${e}`);
      prunedElements = visibleElements;
    }
  }

  // Scope filter — restrict to elements within a CSS selector
  let scopedElements = prunedElements;
  if (options.scope) {
    const { result: scopeResult } = await session.Runtime.evaluate({
      expression: `(function(sel) {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const ids = [...el.querySelectorAll('[data-wt-id]')].map(e => e.getAttribute('data-wt-id')).filter(Boolean);
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, ids: ids };
      })(${JSON.stringify(options.scope)})`,
      returnByValue: true,
    }).catch(() => ({ result: { value: null } }));
    const scopeData = scopeResult?.value as { left: number; top: number; right: number; bottom: number; ids: string[] } | null;
    if (scopeData) {
      const validIds = new Set(scopeData.ids);
      scopedElements = visibleElements.filter(el => {
        if (validIds.has(el.id.replace('w:', ''))) return true;
        if (el.x !== undefined && el.y !== undefined) {
          return el.x >= scopeData.left && el.x <= scopeData.right &&
                 el.y >= scopeData.top && el.y <= scopeData.bottom;
        }
        return false;
      });
    }
  }

  // Query filter
  let filtered = scopedElements;
  if (options.query) {
    const q = options.query.toLowerCase();
    filtered = filtered.filter(
      (el) =>
        el.label.toLowerCase().includes(q) ||
        el.type?.toLowerCase().includes(q) ||
        el.role.toLowerCase().includes(q) ||
        el.id.toLowerCase().includes(q)
    );
  }

  // Limit
  if (options.limit && filtered.length > options.limit) {
    filtered = filtered.slice(0, options.limit);
  }

  return { url, title, elements: filtered, targetId };
}

// ─── toRefEntries — converts ActionElements to RefEntry for delta tracking ───

export function toRefEntries(elements: ActionElement[]): RefEntry[] {
  return elements.map((el) => ({
    id: el.id,
    role: el.role,
    label: el.label,
    type: el.type,
    href: el.href,
    disabled: el.disabled,
    value: el.value,
    fingerprint: el.fingerprint,
  }));
}

export function findAllMatches(
  elements: ActionElement[],
  query: string
): ActionElement[] {
  if (!query || !query.trim()) return [];
  // Helper to normalize element label by stripping ellipsis/punctuation
  const n = (str?: string) => (str || "").toLowerCase().replace(/[\.\u2026\s]+/g, ' ').trim();
  const q = n(query);

  const matches: ActionElement[] = [];
  const addMatch = (el: ActionElement | undefined) => {
    if (el && !matches.find(m => m.id === el.id)) matches.push(el);
  };

  // 1. Exact match (highest priority)
  elements.forEach(el => { if (n(el.label) === q) addMatch(el); });

  // 2. placeholder text
  elements.forEach(el => { if (n(el.placeholder) === q) addMatch(el); });

  // 3. data-testid
  elements.forEach(el => { if (n(el.testId) === q) addMatch(el); });

  // 4. visible text content / partial label match
  elements.forEach(el => { if (n(el.label).includes(q)) addMatch(el); });

  // 4.5 fuzzy partial match (split words)
  const words = q.split(/\s+/);
  if (words.length > 1) {
    elements.forEach(el => { if (words.every(w => n(el.label).includes(w))) addMatch(el); });
  }

  // 5. type match (fallback)
  elements.forEach(el => { if (el.type === query) addMatch(el); });

  return matches;
}

export function findBestMatch(
  elements: ActionElement[],
  query: string
): ActionElement | undefined {
  const matches = findAllMatches(elements, query);
  return matches.length > 0 ? matches[0] : undefined;
}

// ─── Markdown table formatter (Rule 11) ──────────────────────────────────────

export function toMarkdownTable(
  elements: ActionElement[],
  url: string,
  title: string,
  hint?: string
): string {
  const lines: string[] = [];

  if (hint) lines.push(`> ${hint}\n`);
  lines.push(`**${title || url}** — ${url}`);
  lines.push("");

  let minDepth = 999;
  for (const el of elements) {
    if (el.depth < minDepth) minDepth = el.depth;
  }

  for (const el of elements) {
    const indent = "  ".repeat(Math.max(0, el.depth - minDepth));
    const roleTag = `(${formatRole(el.role, el.type)})`;
    const ref = el.id ? ` [${el.id}]` : "";
    const value = el.value ? ` value="${el.value}"` : "";
    
    // Strip everything non-interactive if it doesn't have text
    if (!el.id && !el.label.trim()) continue;

    lines.push(`${indent}${roleTag} "${el.label}"${value}${ref}`);
  }

  return lines.join("\n");
}

function formatRole(role: string, type?: string): string {
  const roleMap: Record<string, string> = {
    button: "Btn", link: "Lnk", textbox: "Input", searchbox: "Search",
    combobox: "Select", checkbox: "Chk", radio: "Radio", listbox: "List",
    menuitem: "Menu", slider: "Slider", tab: "Tab", generic: "Icon",
    heading: "H", paragraph: "P", StaticText: "Text", text: "Text"
  };
  const base = roleMap[role] ?? role;
  return type ? `${base}/${type}` : base;
}

export function safeSelector(el?: ActionElement): string | undefined {
  if (!el) return undefined;
  if (el.selector) return el.selector;
  return undefined;
}

export async function resolveByAria(
  session: CDP.Client,
  query: string
): Promise<{ id: string; label: string; x: number; y: number; selector: string } | null> {
  if (!query || !query.trim()) return null;

  const resp = await session.Runtime.evaluate({
    expression: `(function(q) {
      var INTERACTIVE = 'a[href], button, input:not([type="hidden"]), textarea, select,' +
        '[role="button"],[role="link"],[role="textbox"],[role="checkbox"],' +
        '[role="radio"],[role="combobox"],[role="searchbox"],[role="menuitem"],' +
        '[role="tab"],[role="option"],[tabindex]:not([tabindex="-1"])';
      
      function norm(s) { return (s || '').toLowerCase().replace(/[.\\u2026\\s]+/g, ' ').trim(); }
      var qLow = norm(q);

      // Score: prefer leaf elements (no interactive child = score 0, has child = score 10)
      function score(el) {
        try { return el.querySelector(INTERACTIVE) !== null ? 10 : 0; } catch(e) { return 0; }
      }
      function best(list) {
        if (!list || !list.length) return null;
        var arr = Array.prototype.slice.call(list);
        arr.sort(function(a,b){ return score(a)-score(b); });
        return arr[0];
      }
      function makeResult(el) {
        if (!el) return null;
        var r = el.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) return null;
        if (r.bottom < 0 || r.top > window.innerHeight) return null;
        var sel = '';
        var wtId = el.getAttribute('data-wt-id');
        if (wtId) {
          sel = '[data-wt-id="' + wtId.replace(/"/g, '\\\\"') + '"]';
        } else if (el.id) {
          try { sel = '#' + CSS.escape(el.id); } catch(e) { sel = '#' + el.id; }
        } else {
          var aria = el.getAttribute('aria-label');
          if (aria) sel = el.tagName.toLowerCase() + '[aria-label="' + aria.replace(/"/g, '\\\\"') + '"]';
        }
        if (!sel) {
          var tmp = 'wt-tmp-' + Math.random().toString(36).slice(2,8);
          el.setAttribute('data-wt-id', tmp);
          sel = '[data-wt-id="' + tmp + '"]';
        }
        return {
          label: el.getAttribute('aria-label') || (el.textContent||'').trim().slice(0,80) || q,
          x: Math.round(r.left + r.width/2),
          y: Math.round(r.top + r.height/2),
          selector: sel
        };
      }

      var all, found, i, hit;

      // 1. Exact aria-label
      all = document.querySelectorAll('[aria-label]');
      found = [];
      for (i=0;i<all.length;i++) {
        if (norm(all[i].getAttribute('aria-label'))===qLow) found.push(all[i]);
      }
      if (found.length) { hit=makeResult(best(found)); if(hit) return hit; }

      // 2. Exact innerText on interactive elements
      all = document.querySelectorAll(INTERACTIVE);
      found = [];
      for (i=0;i<all.length;i++) {
        var t = norm(all[i].innerText||all[i].textContent);
        if (t===qLow) found.push(all[i]);
      }
      if (found.length) { hit=makeResult(best(found)); if(hit) return hit; }

      // 3. Placeholder
      all = document.querySelectorAll('[placeholder]');
      found = [];
      for (i=0;i<all.length;i++) {
        if (norm(all[i].getAttribute('placeholder'))===qLow) found.push(all[i]);
      }
      if (found.length) { hit=makeResult(best(found)); if(hit) return hit; }

      // 4. title / alt
      all = document.querySelectorAll('[title],[alt]');
      found = [];
      for (i=0;i<all.length;i++) {
        var v = norm(all[i].getAttribute('title')||all[i].getAttribute('alt'));
        if (v===qLow) found.push(all[i]);
      }
      if (found.length) { hit=makeResult(best(found)); if(hit) return hit; }

      // 5. Fuzzy partial innerText
      all = document.querySelectorAll(INTERACTIVE);
      found = [];
      for (i=0;i<all.length;i++) {
        var t5 = norm(all[i].innerText||all[i].textContent);
        if (t5.indexOf(qLow)>=0 && t5.length < qLow.length*4) found.push(all[i]);
      }
      if (found.length) { hit=makeResult(best(found)); if(hit) return hit; }

      return null;
    })(${JSON.stringify(query)})`,
    returnByValue: true,
  }).catch(() => null);

  const val = resp?.result?.value as { label: string; x: number; y: number; selector: string } | null;
  if (!val) return null;
  return { id: "aria-fallback", label: val.label, x: val.x, y: val.y, selector: val.selector };
}
// axTreeCache is URL-keyed with an insertion-order LRU cap of 50 entries so it
// doesn't grow without bound during long sessions visiting many URLs.
const AX_TREE_CACHE_MAX = 50;
const axTreeCache = new Map<string, ActionMap>();

export function clearAXTreeCache(targetId: string): void {
  // axTreeCache is URL-keyed; targetId param unused but kept for API consistency
  axTreeCache.clear();
}

function axTreeCacheSet(url: string, map: ActionMap): void {
  if (axTreeCache.size >= AX_TREE_CACHE_MAX && !axTreeCache.has(url)) {
    const firstKey = axTreeCache.keys().next().value;
    if (firstKey !== undefined) axTreeCache.delete(firstKey);
  }
  axTreeCache.set(url, map);
}

// ─── buildAXTreeMap ───────────────────────────────────────────────────────────
// Uses CDP Accessibility.getFullAXTree() to build an ActionMap.
// Auto-called by browserMap when DOM-based walker returns sparse or unlabeled-heavy results.
// Agent can also force via browser_map({ ax_tree: true }).

const INTERACTIVE_AX_ROLES = new Set([
  'button', 'link', 'textbox', 'combobox', 'checkbox', 'radio',
  'slider', 'tab', 'menuitem', 'searchbox', 'switch', 'spinbutton',
  'treeitem', 'listbox', 'option', 'menuitemcheckbox', 'menuitemradio',
  'scrollbar', 'tabpanel', 'tree', 'treegrid', 'alert', 'dialog',
  'tooltip', 'status', 'timer',
]);

// These are skipped — they add noise without actionable info.
// Role names must be lowercase because the code lowercases the role string
// before checking the Set. PascalCase names like 'InlineTextBox' or 'StaticText'
// would never match and let noise elements leak into every delta response.
const NOISE_AX_ROLES = new Set([
  'generic', 'inlinetextbox', 'statictext', 'paragraph', 'heading',
  'list', 'listitem', 'none', 'presentation', 'row', 'cell',
  'grid', 'group', 'region', 'document', 'rootwebarea',
]);

export async function buildAXTreeMap(
  session: CDP.Client,
  _options: WalkerOptions = {},
  targetId = "default"
): Promise<ActionMap> {
  // ── Bug #5 fix: begin a new walk pass for AX tree mode ───────────────────────
  // beginWalkPass() resets walkPassSeenIds so the cross-frame dedup registry is
  // fresh for this call.  allocateRefIds() reserves a block of IDs from the
  // global monotonic counter so AX sequential IDs never collide with DOM-walker
  // IDs produced in the same session.
  beginWalkPass();

  const { frameTree } = await session.Page.getFrameTree();
  const url = frameTree.frame.url;
  const title = frameTree.frame.name ?? url ?? "";

  // Check cache
  const cached = axTreeCache.get(url);
  if (cached && cached.elements.length > 0) {
    return cached;
  }

  // Enable accessibility domain
  try {
    await session.Accessibility.enable();
  } catch { /* already enabled */ }

  let nodes: any[] = [];
  try {
    const result = await session.Accessibility.getFullAXTree();
    nodes = result?.nodes ?? [];
  } catch (e) {
    return { url, title, elements: [], targetId };
  }

  // Filter to interactive, non-ignored nodes
  const candidates = nodes.filter((n: any) => {
    if (n.ignored) return false;
    const role = (n.role?.value || '').toLowerCase();
    if (!role || NOISE_AX_ROLES.has(role)) return false;
    return INTERACTIVE_AX_ROLES.has(role) || n.name?.value || n.value?.value;
  });

  // ── Bug #5 fix: allocate a contiguous block of global IDs for this AX pass ──
  // allocateRefIds(candidates.length) advances walkPassGlobalRefCounter by the
  // number of nodes we are about to process, guaranteeing that every w:N ID
  // emitted here is globally unique for the lifetime of the server process.
  const axIdBase = allocateRefIds(candidates.length);
  let axIdCursor = axIdBase;
  const elements: ActionElement[] = [];
  const backendIdsToResolve: number[] = [];

  for (const node of candidates) {
    const role = (node.role?.value || 'generic').toLowerCase();
    let label = node.name?.value || node.description?.value || '';

    // Extract value: for radio/checkbox use the checked property from AX tree.
    // AX tree stores this as node.checked.value ('true'|'false'|'mixed') or
    // node.selected.value ('true'|'false'). Fallback to node.value for text inputs.
    let value: string | undefined;
    if (role === 'radio' || role === 'checkbox' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      const checked = node.properties?.find((p: any) => p.name === 'checked')?.value?.value;
      value = checked === true || checked === 'true' ? 'true' : 'false';
    } else if (role === 'option') {
      const selected = node.properties?.find((p: any) => p.name === 'selected')?.value?.value;
      value = selected === true || selected === 'true' ? 'true' : 'false';
    } else {
      value = node.value?.value !== undefined ? String(node.value.value) : undefined;
    }

    const isSecretRole = role === 'password' || node.name?.value?.toLowerCase().includes('password');
    if (isSecretRole || (node.backendDOMNodeId !== undefined && SessionSecretTracker.isNodeSecret(targetId, node.backendDOMNodeId))) {
      label = '[REDACTED]';
      value = '[REDACTED]';
    }
    // Use globally-unique sequential ID (Bug #5 fix: was local idCounter = 1).
    const id = dedupeRefId(`w:${axIdCursor++}`);

    elements.push({
      id,
      role,
      label,
      value,
      backendNodeId: node.backendDOMNodeId,
      group: 'main_content',
      fingerprint: `ax:${role}:${label || ''}:${axIdCursor}`,
      depth: 0,
    });

    if (node.backendDOMNodeId !== undefined) {
      backendIdsToResolve.push(node.backendDOMNodeId);
    }
  }

  // Filter out WeaveTab overlay elements from AX tree results. Without this,
  // every delta call returned ~50 extra elements from WeaveTab's own chat panel,
  // HUD, and overlay UI injected into the page DOM.
  const filteredElements = elements.filter(el => !isWeaveTabOverlay(el.label, el.selector));

  // Batch-resolve bounding rects for backendNodeIds
  if (backendIdsToResolve.length > 0) {
    try {
      const { nodeIds } = await session.DOM.pushNodesByBackendIdsToFrontend({
        backendNodeIds: backendIdsToResolve,
      });
      if (nodeIds) {
        await Promise.all(nodeIds.map(async (nodeId, i) => {
          try {
            const { model } = await session.DOM.getBoxModel({ nodeId });
            if (model?.content) {
              const content = model.content;
              const cx = Math.round((content[0] + content[4]) / 2);
              const cy = Math.round((content[1] + content[5]) / 2);
              const el = elements.find(e => e.backendNodeId === backendIdsToResolve[i]);
              if (el) {
                el.x = cx;
                el.y = cy;
              }
            }
          } catch { /* element may be detached — skip */ }
        }));
      }
    } catch { /* coordinate resolution best-effort */ }
  }

  const map: ActionMap = { url, title, elements: filteredElements, targetId };
  axTreeCacheSet(url, map);
  return map;
}

