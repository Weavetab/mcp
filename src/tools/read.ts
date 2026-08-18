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

import { analyzeVisualFallback } from "../intelligence/vision.js";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";
import type { ActionElement } from "../cdp/walker.js";

// Cap at 80 elements; form/modal groups are always kept, utility trimmed last.
const MAX_ELEMENTS = 80;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`browserMap timed out after ${ms}ms`)), ms)),
  ]);
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
  /** Debug: draws colored element borders via extension. The screen glow (blue edge fade) is the standard visual indicator, shown automatically during reading states. */
  show_overlays?: boolean;
  /** Force deep shadow DOM traversal (crosses all shadow boundaries to find elements). Auto-enabled when flat query returns sparse results. */
  deep?: boolean;
  /**
   * Run one-shot semantic DOM pruning before returning elements.
   * Drops hidden elements with no interactive descendants and no known toggle-trigger.
   * Replaces SVG icons with [SVG Icon: label] tokens.
   * NOTE: distinct from delta — delta diffs across time, prune compresses the current snapshot once.
   */
  prune?: boolean;
}

function formatLite(el: ActionElement, activeElementId?: string, changedIds?: Set<string>): string {
  const parts: string[] = [];

  // ── State badges ────────────────────────────────────────────────────────────
  if (el.disabled) parts.push("disabled");
  if (activeElementId && el.id === activeElementId) parts.push("FOCUSED");
  if (el.viewport && el.viewport !== "visible") parts.push(`offscreen:${el.viewport}`);

  // ── Value / checked / placeholder ──────────────────────────────────────────
  const role = (el.role || '').toLowerCase();
  const type = (el.type || '').toLowerCase();

  // Radio / checkbox checked state — critical for quiz forms
  if ((role === 'radio' || role === 'checkbox' || type === 'radio' || type === 'checkbox') && el.value !== undefined) {
    parts.push(el.value === 'true' || el.value === 'checked' ? '✓ checked' : '○ unchecked');
  } else if (el.value) {
    // Truncate long values to avoid token waste
    const v = el.value.length > 60 ? el.value.slice(0, 57) + '…' : el.value;
    parts.push(`"${v}"`);
  } else if (el.placeholder) {
    parts.push(`placeholder: "${el.placeholder}"`);
  }

  // ── Type suffix for inputs (e.g. input[email], input[date]) ────────────────
  const typeLabel = (role === 'textbox' || role === 'searchbox' || role === 'combobox') && type
    ? `/${type}` : '';

  // ── Link hint ───────────────────────────────────────────────────────────────
  if (role === 'link' && el.hrefType && el.hrefType !== 'same-origin') {
    parts.push(el.hrefType);
  }

  const state = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  const changed = changedIds?.has(el.id) ? ' ★' : '';
  return `[${el.id}] ${el.role}${typeLabel} "${el.label}"${state}${changed}`;
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

export async function browserMap(
  session: CDP.Client,
  options: ReadOptions = {},
  targetId = "default",
  config: Config
): Promise<string> {
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
          prune: options.prune,
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

      // Never write an AX-tree result into the primary DOM map cache.
      // AX tree uses sequential w:1…w:N IDs; DOM walker uses stable content-addressable hashes.
      // Caching the AX result would make the next plain browser_map() call return AX-tree refs,
      // causing different tools to see different ref numbering for the same element.
      if (!usedAXTree) {
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
  if (map.elements.length === 0) {
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

  // ── Delta mode ─────────────────────────────────────────────────────────────
  if (options.delta) {
    const richDiff = await computeRichDelta(targetId, map.url, map.elements);
    if (richDiff) {
      if ("delta_timeout" in richDiff) {
        // Delta mode timed out — fall through to full read
      } else {
        const lines: string[] = [];
        const header = `Page: ${map.title || map.url} | ${map.elements.length} elements`;
        lines.push(header);

        if (richDiff.added.length === 0 && richDiff.changed.length === 0 && richDiff.removed.length === 0 && (!richDiff.iframes || richDiff.iframes.length === 0)) {
          lines.push("stable — no changes detected");
        } else {
          for (const r of richDiff.added) lines.push(`+ [${r.id}] ${r.role} "${r.label}"`);
          for (const r of richDiff.changed) {
            const changes = Object.keys(r.changes);
            const changeHints = changes.map(c => `${c}: "${r.changes[c].from}" → "${r.changes[c].to}"`).join(', ');
            const actionable = r.actionable ? ` ⚡${r.recommended_action ? ` ${r.recommended_action}` : ''}` : '';
            lines.push(`~ [${r.ref}] ${r.role} "${r.label}"${changeHints ? ` (${changeHints})` : ''}${actionable}`);
          }
          for (const id of richDiff.removed) lines.push(`- ${id}`);
          if (richDiff.iframes) {
            for (const f of richDiff.iframes) {
              const icon = f.status === "added" ? "+" : f.status === "removed" ? "-" : "~";
              lines.push(`${icon} [iframe] ${f.frameUrl} (${f.status}, ${f.elementCount} elements)`);
            }
          }
        }
        if (visualFallback) lines.push(visualFallback);
        return lines.join("\n");
      }
    }
    // No prior snapshot → fall through to full read
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

  // Cure optional-login blindness by explicitly pointing out dismiss buttons
  const dismissButton = map.elements.find(el =>
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

  // ── Semantic section grouping ────────────────────────────────────────────────
  const SECTION_LABEL: Record<ActionElement["group"], string> = {
    navigation:   "── NAV ──────────────────",
    main_content: "── MAIN ─────────────────",
    form:         "── FORM ─────────────────",
    sidebar:      "── SIDEBAR ──────────────",
    modal:        "── MODAL ────────────────",
    utility:      "── OTHER ────────────────",
  };

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

  let currentSection: ActionElement['group'] | null = null;
  for (const el of capped) {
    if (el.group !== currentSection) {
      currentSection = el.group;
      lines.push(SECTION_LABEL[currentSection]);
    }
    lines.push(formatLite(el, activeElementId, changedIds));
  }

  if (overflowCount > 0) {
    lines.push(`(+${overflowCount} more below fold — call browser_scroll down to reveal)`);
  }

  if (visualFallback) lines.push(visualFallback);

  // Context-scoped tool hint — collapse 34-tool surface to ~12 relevant tools.
  // Detected from map elements already computed above — zero extra latency.
  const hasForm   = map.elements.some(e => e.group === "form" || e.role === "input" || e.role === "combobox" || e.role === "checkbox" || e.role === "radio");
  const hasSelect = map.elements.some(e => e.role === "combobox" || e.role === "listbox");
  const hasCanvas = map.url?.includes("canvas") || false;
  const isGithub  = map.url?.includes("github.com") ?? false;

  const baseTools   = ["browser_click", "browser_type", "browser_key", "browser_scroll", "browser_wait", "browser_navigate", "browser_tabs"];
  const formTools   = hasForm   ? ["browser_select", "browser_type_secret", "browser_find"] : [];
  const githubTools = isGithub  ? ["github_analyze", "github_read", "github_issues", "github_get_pr"] : [];
  const canvasTools = hasCanvas ? ["browser_canvas", "browser_screenshot"] : ["browser_screenshot"];
  const diagTools   = ["browser_inspect", "browser_highlight", "browser_scrape", "browser_burst"];

  const contextTools = [...new Set([...baseTools, ...formTools, ...githubTools, ...canvasTools, ...diagTools])];
  lines.push(`\n_tools [${contextTools.join(", ")}]`);

  const output = lines.join("\n");
  const wordCount = output.split(/\s+/).length;
  startReadingSimulation(session, wordCount, config);
  sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } }).catch(() => {});

  return output;
}

// Keep backward-compat alias used by plan.ts
export { browserMap as weaveRead };
