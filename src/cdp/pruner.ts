import { logDebug } from "../audit/logger.js";
import CDP from "chrome-remote-interface";
import type { ActionElement } from "./walker.js";

export async function pruneSnapshot(
  session: CDP.Client,
  rawElements: ActionElement[],
  _targetId = "default",
  structuralIdioms: string[] = []
): Promise<ActionElement[]> {
  if (rawElements.length === 0) return rawElements;

  const rawIds: string[] = rawElements.map((el) =>
    el.id.startsWith("w:") ? el.id.slice(2) : el.id
  );

  const expression = buildEvalExpression(rawIds, structuralIdioms);

  const { result } = await session.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: false,
  });

  if (!result?.value) {
    logDebug("[Pruner] Runtime.evaluate returned no value — skipping prune pass");
    return rawElements;
  }

  let parsed: {
    keptIds: string[];
    svgLabels: Record<string, string>;
    stats: { total: number; pruned: number; svgReplaced: number; elapsedMs: number };
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
    ` ${stats.elapsedMs.toFixed(1)}ms)`
  );

  const keptSet = new Set(keptIds);

  const keptElements: ActionElement[] = [];
  for (const el of rawElements) {
    const rawId = el.id.startsWith("w:") ? el.id.slice(2) : el.id;
    if (!keptSet.has(rawId) && !el.frameUrl) continue;
    const svgLabel = svgLabels[rawId];
    if (svgLabel) {
      keptElements.push({ ...el, label: svgLabel });
    } else {
      keptElements.push(el);
    }
  }

  return keptElements;
}

function buildEvalExpression(rawIds: string[], structuralIdioms: string[] = []): string {
  const idsJson = JSON.stringify(rawIds);
  const idiomsJson = JSON.stringify(structuralIdioms);

  return `(function() {
  var t0 = performance.now();

  var INTERACTIVE_SEL = [
    'a', 'button', 'input', 'textarea', 'select',
    '[role="button"]', '[role="link"]', '[role="textbox"]',
    '[role="checkbox"]', '[role="radio"]', '[role="combobox"]',
    '[role="searchbox"]', '[role="menuitem"]', '[role="tab"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(', ');

  var SVG_ANCESTOR_SEL = 'button, a, [role="button"], [role="menuitem"], [role="tab"]';

  var targetIds = new Set(${idsJson});
  var elementMap = new Map();
  var syntheticPrefix = '__prune_idx_';
  var syntheticEls = [];
  var synIdx = 0;

  function collectElementsDeep(root, visited, depth) {
    if (!visited) visited = new Set();
    if (depth === undefined) depth = 0;
    if (depth > 10 || visited.has(root)) return;
    visited.add(root);

    try {
      var nodes = root.querySelectorAll('[data-wt-id], [data-wt-secret]');
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        var wtId = el.getAttribute('data-wt-id');
        if (!wtId) {
          wtId = syntheticPrefix + (synIdx++);
          el.setAttribute('data-wt-id', wtId);
          syntheticEls.push(el);
          targetIds.add(wtId);
        }
        elementMap.set(wtId, el);
      }
    } catch (e) {}

    try {
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
      while (walker.nextNode()) {
        var cur = walker.currentNode;
        if (cur && cur.shadowRoot && !visited.has(cur.shadowRoot)) {
          collectElementsDeep(cur.shadowRoot, visited, depth + 1);
        }
      }
    } catch (e) {}
  }

  collectElementsDeep(document);

  var controlsMap = new Set();
  var CONTROLS_ATTRS = ['aria-controls', 'aria-owns', 'data-target', 'data-bs-target'];
  var extraIdioms = ${idiomsJson};
  for (var ei = 0; ei < extraIdioms.length; ei++) {
    var cand = extraIdioms[ei];
    if (typeof cand === 'string' && /^[a-zA-Z0-9_:-]+$/.test(cand) && CONTROLS_ATTRS.indexOf(cand) === -1) {
      try {
        document.querySelectorAll('[' + cand + ']');
        CONTROLS_ATTRS.push(cand);
      } catch (e) {}
    }
  }

  for (var ai = 0; ai < CONTROLS_ATTRS.length; ai++) {
    var attr = CONTROLS_ATTRS[ai];
    try {
      var matchedNodes = document.querySelectorAll('[' + attr + ']');
      for (var ci = 0; ci < matchedNodes.length; ci++) {
        var val = matchedNodes[ci].getAttribute(attr);
        if (!val) continue;
        var tokens = val.split(/\\s+/);
        for (var ti = 0; ti < tokens.length; ti++) {
          if (tokens[ti]) controlsMap.add(tokens[ti]);
        }
      }
    } catch (e) {}
  }

  var nodeStack = [];
  try {
    var treeWalker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_ELEMENT, null, false);
    var node = treeWalker.nextNode();
    while (node) {
      nodeStack.push(node);
      node = treeWalker.nextNode();
    }
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

  var keptIds = [];
  var svgLabels = {};
  var prunedCount = 0;
  var svgCount = 0;

  targetIds.forEach(function(wtId) {
    var el = elementMap.get(wtId);
    if (!el) {
      // Element may reside in an OmniBroker child iframe/webview — preserve it
      keptIds.push(String(wtId));
      return;
    }

    if (el.hasAttribute('data-wt-secret')) {
      keptIds.push(String(wtId));
      return;
    }

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
      keptIds.push(String(wtId));
      if (el.tagName && el.tagName.toLowerCase() === 'svg') {
        var label = resolveSvgLabel(el, SVG_ANCESTOR_SEL);
        svgLabels[String(wtId)] = label;
        svgCount++;
      }
      return;
    }

    if (el.__wtHasInteractive) {
      keptIds.push(String(wtId));
      return;
    }

    var elId = el.getAttribute('id');
    if (elId && controlsMap.has(elId)) {
      keptIds.push(String(wtId));
      return;
    }

    prunedCount++;
  });

  for (var cl = 0; cl < nodeStack.length; cl++) {
    try { delete nodeStack[cl].__wtHasInteractive; } catch(e) {}
  }

  for (var ri = 0; ri < syntheticEls.length; ri++) {
    try { syntheticEls[ri].removeAttribute('data-wt-id'); } catch(e) {}
  }

  function resolveSvgLabel(svg, ancestorSel) {
    var label = svg.getAttribute('aria-label');
    if (label && label.trim()) return '[SVG Icon: ' + label.trim() + ']';

    try {
      var title = svg.querySelector('title');
      if (title && title.textContent && title.textContent.trim()) {
        return '[SVG Icon: ' + title.textContent.trim() + ']';
      }
    } catch(e) {}

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

  return JSON.stringify({
    keptIds: keptIds,
    svgLabels: svgLabels,
    stats: {
      total: targetIds.size,
      pruned: prunedCount,
      svgReplaced: svgCount,
      elapsedMs: elapsedMs
    }
  });
})()`;
}
