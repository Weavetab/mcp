import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — tools/read.ts
 * browser_map: ultra-lite page reader with delta mode and visual fallback.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import { buildActionMap, toRefEntries, setShadowDomCache, buildAXTreeMap } from "../cdp/walker.js";
import { logAction } from "../audit/logger.js";
  import { storeSnapshot, computeDelta, computeRichDelta, seedRichSnapshot } from "../state/delta.js";
import { readKnowledgeHint, appendKnowledgeHint } from "../intelligence/hints.js";
import { saveDomainProfile, detectFramework, detectShadowDom, formatDomainHint } from "../intelligence/sessionMemory.js";
import { sessionRegistry } from "../state/session.js";
import { cacheActionMap, getCachedActionMap, getRawCachedActionMap } from "../state/cache.js";
import { startReadingSimulation } from "../overlay/ghost.js";
import { suppressOverlays, restoreOverlays } from "../cdp/extension.js";
import { sendToExtension } from "../cdp/helpers.js";
import { hideWeaveTabOverlay, restoreWeaveTabOverlay } from "../cdp/helpers.js";

import { analyzeVisualFallback } from "../intelligence/vision.js";
import { marksSet, type MarkEntry } from "../intelligence/marks.js";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";
import type { ActionElement } from "../cdp/walker.js";

// Cap at 35 elements by default to keep prompt tokens lean.
// Form, modal, and primary interactive elements are prioritized first.
const MAX_ELEMENTS = 35;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`browserMap timed out after ${ms}ms`)), ms)),
  ]);
}

export interface VisualMark {
  mark: number;
  x: number;
  y: number;
  width: number;
  height: number;
  ref?: string;
  label?: string;
  type?: MarkEntry["type"];
}

export interface BrowserMapResult {
  text: string;
  /** Base64 JPEG of the page annotated with numbered SoM badges. Only present in visual mode. */
  imageBase64?: string;
  /** Structured mark list — numbers match badges visible on the screenshot. */
  marks?: VisualMark[];
}

export interface ReadOptions {
  lite?: boolean;
  full?: boolean;
  scope?: string;
  query?: string;
  limit?: number;
  delta?: boolean;
  intent?: string;
  ax_tree?: boolean;
  /** Debug: draws colored element borders via extension. */
  show_overlays?: boolean;
  /** Force deep shadow DOM traversal. */
  deep?: boolean;
  /** Semantic DOM pruning. Defaults to true to drop non-interactive noise and SVGs. */
  prune?: boolean;
  /**
   * Visual grounding mode (Set-of-Marks).
   * - true  → always inject numbered badges + screenshot.
   * - "auto" → activate only when DOM interactive count < 5 (canvas/WebGL pages).
   * Use browser_click({ mark: N }) to interact with numbered marks.
   */
  visual?: boolean | "auto";
}

function formatLite(el: ActionElement, activeElementId?: string, changedIds?: Set<string>): string {
  const parts: string[] = [];

  // ── State badges ────────────────────────────────────────────────────────────
  if (el.disabled) parts.push("disabled");
  if (activeElementId && el.id === activeElementId) parts.push("FOCUSED");
  if (el.viewport && el.viewport !== "visible" && el.viewport !== "in-viewport") {
    parts.push(el.viewport);
  }

  // ── Value / checked / placeholder ──────────────────────────────────────────
  const role = (el.role || '').toLowerCase();
  const type = (el.type || '').toLowerCase();

  // Radio / checkbox checked state
  if ((role === 'radio' || role === 'checkbox' || type === 'radio' || type === 'checkbox') && el.value !== undefined) {
    parts.push(el.value === 'true' || el.value === 'checked' ? '✓ checked' : '○ unchecked');
  } else if (el.value) {
    const v = el.value.length > 45 ? el.value.slice(0, 42) + '…' : el.value;
    parts.push(`val:"${v}"`);
  } else if (el.placeholder) {
    const p = el.placeholder.length > 35 ? el.placeholder.slice(0, 32) + '…' : el.placeholder;
    parts.push(`ph:"${p}"`);
  }

  // ── Type suffix for inputs ──────────────────────────────────────────────────
  const typeLabel = (role === 'textbox' || role === 'searchbox' || role === 'combobox') && type && type !== 'text'
    ? `/${type}` : '';

  // ── Link hint (only if external) ───────────────────────────────────────────
  if (role === 'link' && el.hrefType === 'external') {
    parts.push('ext');
  }

  const state = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const changed = changedIds?.has(el.id) ? ' ★' : '';
  const label = el.label.length > 50 ? el.label.slice(0, 47) + '…' : el.label;
  return `[${el.id}] ${el.role}${typeLabel} "${label}"${state}${changed}`;
}

// ─── 3.0 High-density formatter helpers ──────────────────────────────────────

/** Collapse a cluster of nav/footer links into a compact summary token. */
function collapseNavCluster(cluster: ActionElement[]): string {
  if (cluster.length === 0) return '';
  if (cluster.length === 1) return formatLite(cluster[0]);
  const first = cluster[0].label.slice(0, 20);
  const last = cluster[cluster.length - 1].label.slice(0, 20);
  const ids = `${cluster[0].id}…${cluster[cluster.length - 1].id}`;
  return `[${ids}] ${cluster.length} links: "${first}" … "${last}"`;
}

/**
 * Format the main element list using 3.0 semantics:
 * - Active modals hoisted to the top
 * - Items under shared container headings grouped
 * - Nav link clusters (4+ consecutive) collapsed
 */
function formatMap3(
  elements: ActionElement[],
  activeElementId: string | undefined,
  changedIds: Set<string>
): string[] {
  const lines: string[] = [];

  // ── 1. Hoist active modal elements ───────────────────────────────────────
  const modalEls = elements.filter(e => e.isModal);
  const mainEls  = elements.filter(e => !e.isModal);

  if (modalEls.length > 0) {
    const modalTitle = modalEls[0].modalTitle || 'Dialog';
    lines.push(`╔═ ACTIVE DIALOG: "${modalTitle}" ${'═'.repeat(Math.max(0, 30 - modalTitle.length))}╗`);
    for (const el of modalEls) {
      lines.push('  ' + formatLite(el, activeElementId, changedIds));
    }
    lines.push(`╚${'═'.repeat(42)}╝`);
    if (mainEls.length > 0) lines.push('');
  }

  // ── 2. Main elements with entity grouping + nav cluster collapsing ────────
  const SECTION_LABEL: Record<ActionElement["group"], string> = {
    navigation:   "── NAV ──────────────────",
    main_content: "── MAIN ─────────────────",
    form:         "── FORM ─────────────────",
    sidebar:      "── SIDEBAR ──────────────",
    modal:        "── MODAL ────────────────",
    utility:      "── OTHER ────────────────",
  };

  let currentSection: ActionElement['group'] | null = null;
  let currentContainer: string | null = null;
  let navCluster: ActionElement[] = [];

  const flushNavCluster = () => {
    if (navCluster.length >= 4) {
      lines.push(collapseNavCluster(navCluster));
    } else {
      for (const ne of navCluster) {
        lines.push(formatLite(ne, activeElementId, changedIds));
      }
    }
    navCluster = [];
  };

  for (const el of mainEls) {
    // Section header
    if (el.group !== currentSection) {
      flushNavCluster();
      currentSection = el.group;
      currentContainer = null;
      lines.push(SECTION_LABEL[currentSection]);
    }

    // Accumulate nav/utility link cluster for potential collapsing
    const isNavLink = (el.group === 'navigation' || el.group === 'utility') && el.role === 'link';
    if (isNavLink) {
      navCluster.push(el);
      continue;
    } else {
      flushNavCluster();
    }

    // Container/entity heading
    const ctx = el.containerContext || null;
    if (ctx && ctx !== currentContainer) {
      currentContainer = ctx;
      const header = ctx.length > 55 ? ctx.slice(0, 52) + '…' : ctx;
      lines.push(`  ┌ ${header}`);
    }

    const indent = ctx ? '  │ ' : '';
    lines.push(indent + formatLite(el, activeElementId, changedIds));
  }
  flushNavCluster();

  return lines;
}

/** Full markdown table mode — only used when full:true is explicitly passed */
function formatFull(elements: ActionElement[], url: string, title: string, hint?: string): string {
  const lines: string[] = [];
  if (hint) lines.push(`> ${hint}\n`);
  lines.push(`**${title || url}** — ${url}\n`);

  for (const el of elements) {
    const role = el.role || '';
    const typeStr = el.type ? `/${el.type}` : '';
    const roleTag = `${role}${typeStr}`;
    const ref = el.id ? ` [${el.id}]` : '';
    const rLow = role.toLowerCase();
    const tLow = (el.type || '').toLowerCase();
    let state = '';
    if (rLow === 'radio' || rLow === 'checkbox' || tLow === 'radio' || tLow === 'checkbox') {
      state = el.value === 'true' || el.value === 'checked' ? ' ✓' : ' ○';
    } else if (el.value) {
      state = ` value="${el.value}"`;
    } else if (el.placeholder) {
      state = ` placeholder="${el.placeholder}"`;
    }
    if (!el.id && !el.label.trim()) continue;
    lines.push(`(${roleTag}) "${el.label}"${state}${ref}`);
  }

  return lines.join('\n');
}

/**
 * Inject numbered Set-of-Marks badges over all interactive elements,
 * take a screenshot, then strip the badges. Returns structured mark data
 * and the annotated image. Zero page pollution after completion.
 */
async function buildVisualGrounding(
  session: CDP.Client,
  targetId: string,
  elements: ActionElement[]
): Promise<{ marks: VisualMark[]; imageBase64: string } | null> {
  try {
    // Build mark data from DOM elements that have coordinates
    const domMarks: VisualMark[] = [];
    for (const el of elements) {
      if (el.x === undefined || el.y === undefined) continue;
      const w = (el as any).width ?? 80;
      const h = (el as any).height ?? 24;
      domMarks.push({
        mark: domMarks.length + 1,
        x: el.x,
        y: el.y,
        width: w,
        height: h,
        ref: el.id,
        label: el.label || undefined,
        type: el.role === "link" ? "link"
          : el.role === "button" ? "button"
          : (el.role === "textbox" || el.role === "searchbox" || el.role === "combobox") ? "input"
          : el.role === "canvas" ? "canvas_region"
          : "unknown",
      });
    }

    // Also discover canvas elements that may not be in the DOM map
    const { result: canvasRes } = await session.Runtime.evaluate({
      expression: `(function(){
        var canvases = [...document.querySelectorAll('canvas')];
        return JSON.stringify(canvases.map(function(c){
          var r = c.getBoundingClientRect();
          return r.width > 0 && r.height > 0 ? {
            x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2),
            w: Math.round(r.width), h: Math.round(r.height)
          } : null;
        }).filter(Boolean));
      })()`,
      returnByValue: true,
    }).catch(() => ({ result: { value: '[]' } }));
    const extraCanvas = JSON.parse(canvasRes.value as string ?? '[]') as Array<{ x: number; y: number; w: number; h: number }>;
    // Add canvas regions not already covered by a nearby DOM mark
    for (const c of extraCanvas) {
      const alreadyCovered = domMarks.some(m => Math.abs(m.x - c.x) < 40 && Math.abs(m.y - c.y) < 40);
      if (!alreadyCovered) {
        domMarks.push({ mark: domMarks.length + 1, x: c.x, y: c.y, width: c.w, height: c.h, type: "canvas_region" });
      }
    }

    if (domMarks.length === 0) return null;

    // Inject badges — fixed-position, shadow-safe, above everything
    const injectExpr = `(function(marks){
      var BADGE_KEY = '__wt_som_badges__';
      if (window[BADGE_KEY]) window[BADGE_KEY].forEach(function(d){ d.parentNode && d.parentNode.removeChild(d); });
      window[BADGE_KEY] = [];
      marks.forEach(function(m){
        var d = document.createElement('div');
        d.setAttribute('data-wt-som', String(m.mark));
        d.style.cssText = 'position:fixed;left:'+(m.x - 10)+'px;top:'+(m.y - 10)+'px;width:20px;height:20px;z-index:2147483647;pointer-events:none;background:#7c3aed;color:#fff;font:bold 11px/20px monospace;text-align:center;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,.5);';
        d.textContent = String(m.mark);
        document.documentElement.appendChild(d);
        window[BADGE_KEY].push(d);
      });
      return true;
    })(${JSON.stringify(domMarks)})`;
    await session.Runtime.evaluate({ expression: injectExpr, returnByValue: true }).catch(() => {});

    // Hide Weavetab overlay so badges are the only overlay in the shot
    await hideWeaveTabOverlay(session).catch(() => {});

    // Capture screenshot
    const { data } = await session.Page.captureScreenshot({ format: 'jpeg', quality: 75 });

    // Restore overlay
    await restoreWeaveTabOverlay(session).catch(() => {});

    // Strip badges immediately
    await session.Runtime.evaluate({
      expression: `(function(){ var b=window['__wt_som_badges__']; if(b) b.forEach(function(d){ d.parentNode&&d.parentNode.removeChild(d); }); window['__wt_som_badges__']=[]; })()`,
      returnByValue: true,
    }).catch(() => {});

    // Persist in mark cache for browser_click({ mark: N }) resolution
    const markMap = new Map<number, import("../intelligence/marks.js").MarkEntry>();
    for (const m of domMarks) {
      markMap.set(m.mark, { x: m.x, y: m.y, width: m.width, height: m.height, ref: m.ref, label: m.label, type: m.type });
    }
    marksSet(targetId, markMap);

    return { marks: domMarks, imageBase64: data };
  } catch (err) {
    logDebug(`[buildVisualGrounding] failed: ${err}`);
    return null;
  }
}

export async function browserMap(
  session: CDP.Client,
  options: ReadOptions = {},
  targetId = "default",
  config: Config
): Promise<string | BrowserMapResult> {
  logDebug(`[browserMap] Initiating read for targetId: ${targetId}, options: ${JSON.stringify(options)}`);

  // ── Wait for DOM and Visual Stability ──────────────────────────────────────
  try {
    await session.Runtime.evaluate({
      expression: `
        new Promise(resolve => {
          if (document.readyState === 'complete') {
            setTimeout(resolve, 300); // 300ms visual stability delay
          } else {
            window.addEventListener('load', () => setTimeout(resolve, 300));
          }
        })
      `,
      awaitPromise: true
    });
  } catch (e) {
    logDebug(`[browserMap] Stability wait failed: ${e}`);
  }

  // Signal reading state via HUD only
  sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: 'reading the page...' } }).catch(() => {});
  
  // Set sticky pruning state if provided, otherwise preserve existing or default to false
  const client = sessionRegistry.getAll().find(c => c.targetId === targetId);
  if (client && options.prune !== undefined) {
    client.pruneActive = options.prune;
  }

  // ── Overlays: default to visible so the user can see the agent's focus ──
  if (options.show_overlays === false) {
    await suppressOverlays(session);
  } else {
    await restoreOverlays(session);
  }

  // ── Build element map: DOM walker or AX tree ─────────────────────────────
  let map: import("../cdp/walker.js").ActionMap | null = null;
  let usedAXTree = false;

  // Check cache first if NOT forcing an AX Tree read explicitly
  if (!options.ax_tree) {
    let currentUrl: string | undefined;
    try {
      const { frameTree } = await session.Page.getFrameTree();
      currentUrl = frameTree.frame.url;
    } catch {}

    // ── Compute fast DOM hash ──────────────────────────────────────────────────
    let domHash = 0;
    try {
      const { result } = await session.Runtime.evaluate({
        expression: 'document.body ? document.body.innerHTML.length : 0',
        returnByValue: true
      });
      domHash = (result.value as number) ?? 0;
    } catch (e) {
      logDebug(`[browserMap] Failed to compute DOM hash: ${e}`);
    }

    const hasFilterOptions = Boolean(options.scope || options.query || options.limit);
    if (!hasFilterOptions) {
      // Try strictly validated cache first
      const cachedMap = getCachedActionMap(targetId, currentUrl);
      if (cachedMap) {
        logDebug(`[browserMap] Cache Hit (strict)! Returning cached action map with ${cachedMap.elements.length} elements.`);
        map = cachedMap;
      } else {
        // Fallback: check raw cache with domHash
        const rawMap = getRawCachedActionMap(targetId, currentUrl);
        if (rawMap && rawMap.domHash === domHash) {
          logDebug(`[browserMap] Cache Hit (domHash=${domHash})! MutationObserver invalidated but DOM content length unchanged.`);
          map = rawMap;
        }
      }
    }
  }

  if (!map) {
    if (options.ax_tree) {
      // Explicit AX tree mode — skips DOM walker entirely
      map = await buildAXTreeMap(session, {
        scope: options.scope as any,
        query: options.query,
        limit: options.limit,
      }, targetId);
      usedAXTree = map.elements.length > 0;
      logDebug(`[browserMap] AX tree mode: ${map.elements.length} elements`);
    } else {
      const _emptyMap: import('../cdp/walker.js').ActionMap = { url: '', title: '', elements: [], targetId };
      // DOM-based walker (standard path) — 8s timeout prevents hanging on heavy SPAs
      map = await withTimeout(buildActionMap(
        session,
        {
          scope: options.scope as any,
          query: options.query,
          limit: options.limit,
          deep: options.deep,
          prune: options.prune !== false,
        },
        targetId
      ), 8000).catch(() => _emptyMap);
      logDebug(`[browserMap] buildActionMap completed. Elements found: ${map.elements.length}`);

      // Auto-fallback to AX tree when DOM walker returns sparse or unlabeled-heavy results
      if (map.elements.length > 0 && map.elements.length < 3) {
        const axMap = await withTimeout(buildAXTreeMap(session, {}, targetId), 6000).catch(() => _emptyMap);
        if (axMap.elements.length > map.elements.length) {
          map = axMap;
          usedAXTree = true;
          logDebug(`[browserMap] AX tree fallback (sparse DOM): ${map.elements.length} elements`);
        }
      } else if (map.elements.length > 0) {
        const total = map.elements.length;
        const unlabeled = map.elements.filter(e => !e.label && !e.value && !e.placeholder).length;
        if (unlabeled / total > 0.5) {
          const axMap = await withTimeout(buildAXTreeMap(session, {}, targetId), 6000).catch(() => _emptyMap);
          if (axMap.elements.length > 0) {
            map = axMap;
            usedAXTree = true;
            logDebug(`[browserMap] AX tree fallback (>50% unlabeled): ${map.elements.length} elements`);
          }
        }
      }

      // Record AX tree strategy in domain profile for future sessions
      if (usedAXTree) {
        try {
          const hostname = new URL(map.url).hostname;
          await saveDomainProfile(hostname, { strategies: ["axtree"] }).catch(() => {});
        } catch { /* best-effort */ }
      }
    }

    try {
      // Request document first to prevent CDP error
      await session.DOM.getDocument({ depth: -1 }).catch(() => {});
      
      // Calculate domHash if not already calculated (e.g. from AX tree fallback)
      try {
        const { result } = await session.Runtime.evaluate({
          expression: 'document.body ? document.body.innerHTML.length : 0',
          returnByValue: true
        });
        map.domHash = (result.value as number) ?? 0;
      } catch (e) {}

      // Never write an AX-tree result or a filtered map into the primary DOM map cache.
      // AX tree uses sequential w:1…w:N IDs; DOM walker uses stable content-addressable hashes.
      // Caching a filtered or AX result would make subsequent plain browser_map() calls return incomplete refs.
      const hasFilterOptions = Boolean(options.scope || options.query || options.limit);
      if (!usedAXTree && !hasFilterOptions) {
        cacheActionMap(targetId, map);
      }
      logAction("browser_map", map.url, `${map.elements.length} elements`);

      // Auto-learn domain profile (non-blocking)
      try {
        const hostname = new URL(map.url).hostname;
        const [framework, hasShadowDom] = await Promise.all([
          detectFramework(session).catch(() => undefined),
          detectShadowDom(session).catch(() => false),
        ]);
        if (framework || hasShadowDom) {
          await saveDomainProfile(hostname, {
            ...(framework ? { framework } : {}),
            ...(hasShadowDom ? { shadowDom: true } : {}),
          }).catch(() => {});
        }
        // Proactively seed shadow DOM cache for next browser_map call
        if (hasShadowDom) {
          setShadowDomCache(targetId, true);
        }
      } catch { /* domain profile is best-effort */ }

      // Filter out unresolvable nodes
      const backendIds = map.elements.map(e => e.backendNodeId).filter((id): id is number => id !== undefined);
      logDebug(`[browserMap] Resolving ${backendIds.length} backend node IDs.`);

      const resolved = await session.DOM.pushNodesByBackendIdsToFrontend({
        backendNodeIds: backendIds
      });

      if (resolved.nodeIds) {
        logDebug(`[browserMap] Resolved ${resolved.nodeIds.length} node IDs.`);
        const validIds = new Set(resolved.nodeIds.filter(id => id !== 0));
        map!.elements = map!.elements.filter(el => {
          if (el.backendNodeId === undefined) return true;
          const nodeId = resolved.nodeIds[map!.elements.indexOf(el)];
          return nodeId !== undefined && validIds.has(nodeId);
        });
        logDebug(`[browserMap] Elements after resolution filter: ${map.elements.length}`);
      } else {
        logDebug(`[browserMap] No node IDs resolved.`);
      }
    } catch (e) {
      logDebug(`[browserMap] Error during read: ${e}`);
      throw e;
    }
  }

  const newRefs = toRefEntries(map.elements);
  const tabs = sessionRegistry.getAll();
  const activeTabId = sessionRegistry.getActive(getConfigAgentId(config))?.targetId ?? targetId;

  // ── Visual fallback when AX tree is empty ──────────────────────────────────
  let visualFallback: string | null = null;
  const hasFilter = Boolean(options.query || options.scope);

  if (map.elements.length === 0 && !hasFilter) {
    try {
      // Canvas detection — check before full screenshot analysis
      const { result: canvasCheck } = await session.Runtime.evaluate({
        expression: `(function() {
          const canvases = [...document.querySelectorAll('canvas')];
          return JSON.stringify(canvases.map(c => {
            const rect = c.getBoundingClientRect();
            return {
              id: c.id || '', width: Math.round(rect.width), height: Math.round(rect.height),
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              hasWebGL: !!(c.getContext('webgl') || c.getContext('webgl2'))
            };
          }));
        })()`,
        returnByValue: true,
      }).catch(() => ({ result: { value: '[]' } }));
      const canvases = JSON.parse(canvasCheck.value as string ?? '[]') as Array<{ id: string; width: number; height: number; x: number; y: number; hasWebGL: boolean }>;

      if (canvases.length > 0) {
        for (let i = 0; i < canvases.length; i++) {
          const c = canvases[i];
          if (c.width > 0 && c.height > 0) {
            map.elements.push({
              id: `w:canvas${i}`,
              role: "canvas",
              label: `${c.hasWebGL ? 'WebGL ' : ''}Canvas ${c.width}x${c.height}${c.id ? ` #${c.id}` : ''}`,
              group: "main_content",
              fingerprint: `canvas:${i}:${c.id}`,
              depth: 0,
              x: c.x,
              y: c.y,
              selector: c.id ? `#${c.id}` : `canvas:nth-of-type(${i+1})`
            });
          }
        }
      }

      if (map.elements.length === 0) {
        const vf = await analyzeVisualFallback(session);
        const zones = vf.clickable_zones
          .map((z) => `  coords(${z.x},${z.y})`)
          .join("\n");
        visualFallback =
          `\nVISUAL FALLBACK (AX tree empty)\n` +
          `  page_state: ${vf.page_state}\n` +
          `  text_density: ${vf.text_density}%\n` +
          `  heatmap: ${vf.content_heatmap}\n` +
          (zones ? `  clickable_zones:\n${zones}\n` : "  no clickable zones detected\n");
      }
    } catch {
      visualFallback = "\nVISUAL FALLBACK: unavailable\n";
    }
  }

  // If we just added canvases, we need to update newRefs
  if (map.elements.length > 0 && newRefs.length === 0) {
    newRefs.push(...toRefEntries(map.elements));
  }

  // ── Delta / Auto-Delta mode ────────────────────────────────────────────────
  // If delta is explicit OR if the user is re-reading the same page without full/force options,
  // auto-delta returns only what changed (saving up to 95% prompt tokens).
  const autoDeltaEligible = options.delta === true || (
    options.delta !== false &&
    !options.full &&
    !options.query &&
    !options.scope
  );

  if (autoDeltaEligible) {
    const richDiff = await computeRichDelta(targetId, map.url, map.elements);
    if (richDiff && !("delta_timeout" in richDiff)) {
      const totalChanges = richDiff.added.length + richDiff.changed.length + richDiff.removed.length;
      
      // Auto-delta: if 0 changes or <= 15 changes, return the diff directly
      if (options.delta === true || totalChanges <= 15) {
        const lines: string[] = [];
        const header = `Page: ${map.title || map.url} | ${map.elements.length} elements`;
        lines.push(header);

        if (totalChanges === 0 && (!richDiff.iframes || richDiff.iframes.length === 0)) {
          lines.push("stable — no DOM changes since last map (use existing refs)");
        } else {
          const maxLines = 40;
          let printed = 0;

          for (const r of richDiff.added) {
            if (printed >= maxLines) break;
            lines.push(`+ [${r.id}] ${r.role} "${r.label}"`);
            printed++;
          }
          for (const r of richDiff.changed) {
            if (printed >= maxLines) break;
            const changes = Object.keys(r.changes);
            const changeHints = changes.map(c => `${c}: "${r.changes[c].from}" → "${r.changes[c].to}"`).join(', ');
            const actionable = r.actionable ? ` ⚡${r.recommended_action ? ` ${r.recommended_action}` : ''}` : '';
            lines.push(`~ [${r.ref}] ${r.role} "${r.label}"${changeHints ? ` (${changeHints})` : ''}${actionable}`);
            printed++;
          }
          for (const id of richDiff.removed) {
            if (printed >= maxLines) break;
            lines.push(`- [${id}] (removed)`);
            printed++;
          }
          if (richDiff.iframes) {
            for (const f of richDiff.iframes) {
              if (printed >= maxLines) break;
              const icon = f.status === "added" ? "+" : f.status === "removed" ? "-" : "~";
              lines.push(`${icon} [iframe] ${f.frameUrl} (${f.status}, ${f.elementCount} elements)`);
              printed++;
            }
          }
          if (totalChanges > printed) {
            lines.push(`... (+${totalChanges - printed} more changes omitted)`);
          }
        }
        if (visualFallback) lines.push(visualFallback);
        return lines.join("\n");
      }
    }
  }

  storeSnapshot(targetId, map.url, newRefs);
  seedRichSnapshot(targetId, map.url, map.elements);

  // JIT knowledge hint + session memory
  let hint: string | undefined;
  try {
    const hostname = new URL(map.url).hostname;
    const [knowledge, domainProfile] = await Promise.all([
      readKnowledgeHint(hostname),
      import("../intelligence/sessionMemory.js").then(m => m.loadDomainProfile(hostname)),
    ]);
    const memoryHint = domainProfile ? formatDomainHint(hostname, domainProfile) : undefined;
    hint = [knowledge, memoryHint].filter(Boolean).join('\n') || undefined;
  } catch { /* ignore */ }

  // ── Full table mode (explicit full:true only) ───────────────────────────────
  if (options.full) {
    const markdown = formatFull(map.elements, map.url, map.title, hint);
    const wordCount = markdown.split(/\s+/).length;
    startReadingSimulation(session, wordCount, config);
    const tabLine = `⬡ ${tabs.length} tab(s) | active: ${activeTabId}`;
    return tabLine + "\n\n" + markdown + (visualFallback ?? "");
  }

  // ── Prioritised element capping ──────────────────────────────────────────────
  // Keep form/modal elements at all costs (they're the most actionable).
  // Trim utility/nav from the end if we're over the cap.
  let capped: typeof map.elements;
  if (map.elements.length > MAX_ELEMENTS) {
    const priority   = map.elements.filter(e => e.group === 'form' || e.group === 'modal');
    const secondary  = map.elements.filter(e => e.group === 'main_content' || e.group === 'sidebar');
    const tertiary   = map.elements.filter(e => e.group === 'navigation' || e.group === 'utility');
    capped = [...priority, ...secondary, ...tertiary].slice(0, MAX_ELEMENTS);
  } else {
    capped = map.elements;
  }
  const overflowCount = map.elements.length - capped.length;

  const lines: string[] = [];
  if (hint) lines.push(`> ${hint}`);

  // Cure optional-login blindness by explicitly pointing out dismiss buttons on true modals
  const isTitlebarControl = (el: any) => {
    const sel = (el.selector || "").toLowerCase();
    const lbl = (el.label || "").toLowerCase();
    const isTopCorner = (el.y !== undefined && el.y < 45 && el.x !== undefined && el.x > 800);
    return isTopCorner || sel.includes("win-close") || sel.includes("titlebar") || sel.includes("window-controls") || lbl === "close window";
  };

  const hasModalContext = map.elements.some(el => (el as any).isModal || el.role === "dialog" || el.role === "alertdialog");
  const dismissButton = map.elements.find(el =>
    (hasModalContext || (el as any).isModal) &&
    !isTitlebarControl(el) &&
    /(not now|skip|close|dismiss|no thanks|^x$)/i.test(el.label) &&
    /(button|link)/i.test(el.role)
  );
  if (dismissButton) {
    lines.push(`\n🚨 [POPUP DETECTED]: If an optional modal/login is blocking the page, try clicking [${dismissButton.id}] ("${dismissButton.label}") to dismiss it.\n`);
  }

  const changed = computeDelta(targetId, map.url, newRefs);
  const changedIds = new Set(
    changed ? [...changed.added.map((r) => r.id), ...changed.changed.map((r) => r.id)] : []
  );

  const beforePruneCount = map.elements.length;
  lines.push(
    `Page: ${map.title || map.url} | ${map.elements.length} interactive elements` +
    (changedIds.size > 0 ? ` | ${changedIds.size} changed` : "") +
    (options.prune && beforePruneCount !== map.elements.length
      ? ` (pruned ${beforePruneCount - map.elements.length})`
      : "")
  );
  lines.push("");

  // ── Semantic section grouping (3.0) ────────────────────────────────────────
  let activeElementId: string | undefined;
  try {
    const { result } = await session.Runtime.evaluate({
      expression: `(function() {
        const ae = document.activeElement;
        if (!ae || ae === document.body) return null;
        return ae.getAttribute('data-wt-id') || null;
      })()`,
      returnByValue: true
    });
    if (result && result.value) {
      activeElementId = 'w:' + (result.value as string);
    }
  } catch {}

  lines.push(...formatMap3(capped, activeElementId, changedIds));

  if (overflowCount > 0) {
    lines.push(`(+${overflowCount} more below fold — call browser_scroll down to reveal)`);
  }

  if (visualFallback) lines.push(visualFallback);

  const output = lines.join("\n");
  const wordCount = output.split(/\s+/).length;
  startReadingSimulation(session, wordCount, config);
  sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } }).catch(() => {});

  // ── Visual Grounding (Set-of-Marks) ────────────────────────────────────────
  // Trigger when: visual:true (always) OR visual:"auto" (DOM element count < 5).
  const shouldVisual =
    options.visual === true ||
    (options.visual === "auto" && capped.length < 5);

  if (shouldVisual) {
    const vg = await buildVisualGrounding(session, targetId, map.elements);
    if (vg) {
      const markSummary = vg.marks
        .map(m => `  [${m.mark}] ${m.type ?? "unknown"}${m.ref ? ` ${m.ref}` : ""} "${m.label ?? ""}" @(${m.x},${m.y})`)
        .join("\n");
      const annotatedText = output + `\n\n── Visual Marks (use browser_click({ mark: N })) ──\n${markSummary}`;
      return { text: annotatedText, imageBase64: vg.imageBase64, marks: vg.marks } satisfies BrowserMapResult;
    }
  }

  return output;
}

// Backward-compat alias
export { browserMap as weaveRead };
