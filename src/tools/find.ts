/**
 * Weavetab — tools/find.ts
 * browser_find: DEPRECATED — prefer browser_click with action:'find' which uses the same
 * resolution chain but with memory-intercept and URC cache for 10x faster results.
 * This shim is kept for backward compatibility only.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { buildActionMap, findAllMatches, resolveByAria } from "../cdp/walker.js";

export interface FindOptions {
  query: string;
  role?: string;
  fuzzy?: boolean;
  matchPlaceholder?: boolean;
  matchTitle?: boolean;
  all?: boolean;
  limit?: number;
}

export interface FindItem {
  ref?: string;
  selector: string;
  label: string;
  tag?: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface FindResult {
  success: boolean;
  found: boolean;
  total_matches?: number;
  matches?: FindItem[];
  rect?: { x: number; y: number; width: number; height: number };
  nodeId?: number;
  selector?: string;
  label?: string;
}

export async function browserFind(
  session: CDP.Client,
  options: FindOptions,
  _config: Config
): Promise<FindResult> {
  const { query, all = false, limit = 10 } = options;

  if (!query) throw new Error("browser_find requires a query string");

  const { result } = await session.Runtime.evaluate({
    expression: `(function(q, returnAll, maxMatches) {
      function norm(s) { return (s || '').toLowerCase().replace(/[.\\u2026\\s]+/g, ' ').trim(); }
      var qLow = norm(q);
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null, false);
      var matchedNodes = [];
      var seenElements = new Set();

      while (walker.nextNode()) {
        var node = walker.currentNode;
        var el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        if (!el || seenElements.has(el)) continue;

        var text = norm(node.textContent);
        var aria = norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '');

        if ((text && text.includes(qLow)) || (aria && aria.includes(qLow))) {
          seenElements.add(el);
          matchedNodes.push(el);
          if (!returnAll && matchedNodes.length >= 1) break;
          if (matchedNodes.length >= maxMatches) break;
        }
      }

      if (matchedNodes.length === 0) return null;

      var out = matchedNodes.map(function(match, i) {
        var r = match.getBoundingClientRect();
        var wtId = match.getAttribute('data-wt-id');
        var sel = '';
        if (wtId) {
          sel = '[data-wt-id="' + wtId + '"]';
        } else if (match.id) {
          sel = '#' + CSS.escape(match.id);
        } else {
          var tmp = 'wt-find-' + i + '-' + Math.random().toString(36).slice(2,6);
          match.setAttribute('data-wt-id', tmp);
          sel = '[data-wt-id="' + tmp + '"]';
          wtId = tmp;
        }
        return {
          ref: 'w:' + wtId,
          label: match.getAttribute('aria-label') || (match.textContent||'').trim().slice(0,80) || q,
          tag: match.tagName.toLowerCase(),
          x: Math.round(r.left),
          y: Math.round(r.top),
          width: Math.round(r.width),
          height: Math.round(r.height),
          selector: sel
        };
      });

      return JSON.stringify(out);
    })(${JSON.stringify(query)}, ${JSON.stringify(all)}, ${JSON.stringify(limit)})`,
    returnByValue: true
  }).catch(() => ({ result: { value: null } }));

  if (result && result.value) {
    const list: any[] = JSON.parse((result.value as string) || '[]');
    if (list.length > 0) {
      const first = list[0];
      return {
        success: true,
        found: true,
        total_matches: list.length,
        matches: list.map(m => ({
          ref: m.ref,
          selector: m.selector,
          label: m.label,
          tag: m.tag,
          rect: { x: m.x, y: m.y, width: m.width, height: m.height }
        })),
        rect: { x: first.x, y: first.y, width: first.width, height: first.height },
        selector: first.selector,
        label: first.label
      };
    }
  }

  return { success: true, found: false, total_matches: 0, matches: [] };
}
