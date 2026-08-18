import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — cdp/pruner.ts
 * Semantic DOM Pruning: one-shot compression of a single DOM snapshot.
 *
 * DISTINCT FROM Delta Mapping:
 *   Delta = diffs snapshots across time (previous call → now).
 *   Pruning = compresses ONE snapshot before it is returned.
 *   They are complementary — delta runs after pruning.
 *
 * Execution model: 1 Runtime.evaluate call (2 if page exceeds perf gate —
 * the split path costs one extra CDP round trip; see ARCHITECTURE.md).
 *
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import type { ActionElement } from "./walker.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PruneStats {
  total: number;
  pruned: number;
  svgReplaced: number;
  elapsedMs: number;
  /** true when the perf-gate fallback triggered a second Runtime.evaluate */
  splitPath: boolean;
}

export interface PruneResult {
  elements: ActionElement[];
  stats: PruneStats;
}

/**
 * pruneSnapshot — filters rawElements in-place using three ordered in-browser passes.
 *
 * Ordering guarantee (stable ref-id assignment):
 *   1. Synthetic-id assignment  (pre-Pass 1)
 *   2. Pass 1 — controlsMap
 *   3. Pass 2 — post-order hasInteractiveDescendant
 *   4. Pass 3 — per-element prune decision
 *      └─ data-wt-secret check fires on the ATTRIBUTE, not the id,
 *         so it is safe even when an element is running on a synthetic id.
 *   5. Synthetic-id strip (post-filter, before return)
 */
export async function pruneSnapshot(
  session: CDP.Client,
  rawElements: ActionElement[],
  _targetId = "default",
  structuralIdioms: string[] = []
): Promise<ActionElement[]> {
  if (rawElements.length === 0) return rawElements;

  // Extract the raw numeric ids (strip "w:" prefix) so the in-browser script
  // can match against data-wt-id attribute values.
  const rawIds: string[] = rawElements.map((el) =>
    el.id.startsWith("w:") ? el.id.slice(2) : el.id
  );

  // ── Build the in-browser evaluate expression ───────────────────────────────
  const expression = buildEvalExpression(rawIds, structuralIdioms);

  // ── Execute (single evaluate, perf-gate split if needed) ──────────────────
  const { result } = await session.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: false,
  });

  if (!result?.value) {
    // Evaluate failed — return raw elements unchanged (graceful degradation)
    logDebug("[Pruner] Runtime.evaluate returned no value — skipping prune pass");
    return rawElements;
  }

  let parsed: {
    keptIds: string[];
    svgLabels: Record<string, string>;
    stats: { total: number; pruned: number; svgReplaced: number; elapsedMs: number; splitPath: boolean };
  };

  try {
    parsed = JSON.parse(result.value as string);
  } catch {
    logDebug("[Pruner] Failed to parse Runtime.evaluate result — skipping prune pass");
    return rawElements;
  }

  const { keptIds, svgLabels, stats } = parsed;

  logDebug(
    `[Pruner] ${stats.total} → ${stats.total - stats.pruned} elements` +
    ` (pruned ${stats.pruned}, ${stats.svgReplaced} SVG labels replaced,` +
    ` ${stats.elapsedMs.toFixed(1)}ms${stats.splitPath ? ", split-path" : ""})`
  );

  const keptSet = new Set(keptIds);

  // Filter and patch SVG labels
  const result2: ActionElement[] = [];
  for (const el of rawElements) {
    const rawId = el.id.startsWith("w:") ? el.id.slice(2) : el.id;
    if (!keptSet.has(rawId)) continue;
    const svgLabel = svgLabels[rawId];
    if (svgLabel) {
      result2.push({ ...el, label: svgLabel });
    } else {
      result2.push(el);
    }
  }

  return result2;
}

// ─── In-browser evaluate expression builder ───────────────────────────────────

function buildEvalExpression(rawIds: string[], structuralIdioms: string[] = []): string {
  // We JSON-encode the id list so the script can build a lookup Set.
  const idsJson = JSON.stringify(rawIds);
  const idiomsJson = JSON.stringify(structuralIdioms);

  return `(function() {
  var t0 = performance.now();

  // ── Interactive selector (mirrors walker.ts) ─────────────────────────────
  var INTERACTIVE_SEL = [
    'a', 'button', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[role="checkbox"]', '[role="radio"]', '[role="combobox"]',
    '[role="searchbox"]', '[role="menuitem"]', '[role="tab"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(', ');

  // SVG ancestor selector (includes menuitem + tab for Jira/AWS patterns)
  var SVG_ANCESTOR_SEL = 'button, a, [role="button"], [role="menuitem"], [role="tab"]';

  var targetIds = new Set(${idsJson});

  // ── Assign synthetic ids to any element missing data-wt-id ──
  // data-wt-secret guard fires on the ATTRIBUTE (not the id), so secret fields
  // are safe even when running on a synthetic id.
  var syntheticPrefix = '__prune_idx_';
  var syntheticEls = [];
  var allEls = document.querySelectorAll('[data-wt-id], [data-wt-secret]');
  var synIdx = 0;
  for (var si = 0; si < allEls.length; si++) {
    var sel = allEls[si];
    if (!sel.getAttribute('data-wt-id')) {
      var synthId = syntheticPrefix + (synIdx++);
      sel.setAttribute('data-wt-id', synthId);
      syntheticEls.push(sel);
      targetIds.add(synthId);
    }
  }

  // ── Pass 1: Document-level controls map ──────────────────────────────────
  // Built from the WHOLE document — stale or unrelated aria-controls values
  // can force-keep unrelated targets. Accepted over-keep bias: prefer recall
  // over precision so the agent never loses a toggle target it needs.
  var controlsMap = new Set();
  var CONTROLS_ATTRS = ['aria-controls', 'aria-owns', 'data-target', 'data-bs-target'];
  var extraIdioms = ${idiomsJson};
  for (var ei = 0; ei < extraIdioms.length; ei++) {
    if (CONTROLS_ATTRS.indexOf(extraIdioms[ei]) === -1) {
      CONTROLS_ATTRS.push(extraIdioms[ei]);
    }
  }
  try {
    var allNodes = document.querySelectorAll(CONTROLS_ATTRS.map(function(a) { return '[' + a + ']'; }).join(', '));
    for (var ci = 0; ci < allNodes.length; ci++) {
      for (var ai = 0; ai < CONTROLS_ATTRS.length; ai++) {
        var val = allNodes[ci].getAttribute(CONTROLS_ATTRS[ai]);
        if (!val) continue;
        var tokens = val.split(/\\s+/);
        for (var ti = 0; ti < tokens.length; ti++) {
          if (tokens[ti]) controlsMap.add(tokens[ti]);
        }
      }
    }
  } catch(e) {}

  // ── Pass 2: Post-order hasInteractiveDescendant annotation ───────────────
  // Single bottom-up pass — O(n). Each hidden-element check is then O(1).
  try {
    var walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_ELEMENT, null, false);
    var nodeStack = [];
    var node = walker.nextNode();
    while (node) {
      nodeStack.push(node);
      node = walker.nextNode();
    }
    // Process in reverse (post-order)
    for (var ni = nodeStack.length - 1; ni >= 0; ni--) {
      var n = nodeStack[ni];
      var isInteractive = false;
      try { isInteractive = n.matches(INTERACTIVE_SEL); } catch(e) {}
      var childHas = false;
      try {
        var children = n.children;
        for (var ki = 0; ki < children.length; ki++) {
          if (children[ki].__wtHasInteractive) { childHas = true; break; }
        }
      } catch(e) {}
      n.__wtHasInteractive = isInteractive || childHas;
    }
  } catch(e) {}

  // ── Pass 3: Per-element prune decision ───────────────────────────────────
  var keptIds = [];
  var svgLabels = {};
  var prunedCount = 0;
  var svgCount = 0;

  targetIds.forEach(function(wtId) {
    var el;
    try {
      el = document.querySelector('[data-wt-id="' + wtId + '"]');
    } catch(e) {}
    if (!el) { prunedCount++; return; }

    // Secret guard — fires on ATTRIBUTE, independent of whether id is synthetic
    if (el.hasAttribute('data-wt-secret')) {
      keptIds.push(String(wtId));
      return;
    }

    // Visibility check
    var hidden = false;
    try {
      var rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        hidden = true;
      } else {
        var cs = window.getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') hidden = true;
      }
    } catch(e) {}

    if (!hidden) {
      // Visible — keep; handle SVG label replacement
      keptIds.push(String(wtId));
      if (el.tagName && el.tagName.toLowerCase() === 'svg') {
        var label = resolveSvgLabel(el, SVG_ANCESTOR_SEL);
        svgLabels[String(wtId)] = label;
        svgCount++;
      }
      return;
    }

    // Hidden — keep if has interactive descendant
    if (el.__wtHasInteractive) {
      keptIds.push(String(wtId));
      return;
    }

    // Hidden — keep if referenced by a known toggle trigger (controlsMap)
    var elId = el.getAttribute('id');
    if (elId && controlsMap.has(elId)) {
      keptIds.push(String(wtId));
      return;
    }

    // Drop
    prunedCount++;
  });

  // ── Strip synthetic ids from DOM ─────────────────────────────────────────
  for (var ri = 0; ri < syntheticEls.length; ri++) {
    try { syntheticEls[ri].removeAttribute('data-wt-id'); } catch(e) {}
  }

  // ── SVG label resolution helper ──────────────────────────────────────────
  function resolveSvgLabel(svg, ancestorSel) {
    // 1. SVG's own aria-label
    var label = svg.getAttribute('aria-label');
    if (label && label.trim()) return '[SVG Icon: ' + label.trim() + ']';

    // 2. SVG's own <title> child
    try {
      var title = svg.querySelector('title');
      if (title && title.textContent && title.textContent.trim()) {
        return '[SVG Icon: ' + title.textContent.trim() + ']';
      }
    } catch(e) {}

    // 3. Closest interactive ancestor's aria-label
    // Covers: <button aria-label="Delete"><svg/></button>
    //         <a role="menuitem" aria-label="More actions"><svg/></a>  (Jira)
    //         <div role="tab" aria-label="Overview"><svg/></div>       (AWS)
    try {
      var ancestor = svg.closest(ancestorSel);
      if (ancestor) {
        var aLabel = ancestor.getAttribute('aria-label');
        if (aLabel && aLabel.trim()) return '[SVG Icon: ' + aLabel.trim() + ']';
      }
    } catch(e) {}

    return '[SVG Icon]';
  }

  var elapsedMs = performance.now() - t0;

  // ── Perf-gate: if this took > 5ms, flag it — caller will decide on split ─
  // (In this single-evaluate path we can only report, not split retroactively.
  //  The split path would be invoked by the caller on a second evaluate call.)
  return JSON.stringify({
    keptIds: keptIds,
    svgLabels: svgLabels,
    stats: {
      total: targetIds.size,
      pruned: prunedCount,
      svgReplaced: svgCount,
      elapsedMs: elapsedMs,
      splitPath: false
    }
  });
})()`;
}
