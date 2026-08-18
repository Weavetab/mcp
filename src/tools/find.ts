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
  role?: string;           // Filter by role (button, link, textbox, etc.)
  fuzzy?: boolean;         // Enable fuzzy matching (default: true)
  matchPlaceholder?: boolean; // Search placeholder text (default: true)
  matchTitle?: boolean;    // Search title attribute (default: true)
}

export interface FindResult {
  success: boolean;
  found: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  nodeId?: number;
  selector?: string;       // CSS selector for the found element
  label?: string;          // The actual label/text that matched
}

export async function browserFind(
  session: CDP.Client,
  options: FindOptions,
  _config: Config
): Promise<FindResult> {
  const { query, role, fuzzy = true, matchPlaceholder = true, matchTitle = true } = options;

  if (!query) throw new Error("browser_find requires a query string");

  // Find tool must search ALL elements, not just interactive ones.
  const { result } = await session.Runtime.evaluate({
    expression: `(function(q) {
      function norm(s) { return (s || '').toLowerCase().replace(/[.\\u2026\\s]+/g, ' ').trim(); }
      var qLow = norm(q);
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null, false);
      var matches = [];
      while (walker.nextNode()) {
        var node = walker.currentNode;
        if (node.nodeType === Node.TEXT_NODE) {
          var t = norm(node.textContent);
          if (t && t.includes(qLow)) {
            matches.push(node.parentElement);
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          var el = node;
          var aria = norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '');
          if (aria && aria.includes(qLow)) {
            matches.push(el);
          }
        }
      }
      if (matches.length === 0) return null;
      var match = matches[0];
      var r = match.getBoundingClientRect();
      var sel = '';
      if (match.id) {
        sel = '#' + CSS.escape(match.id);
      } else {
        var tmp = 'wt-tmp-' + Math.random().toString(36).slice(2,8);
        match.setAttribute('data-wt-id', tmp);
        sel = '[data-wt-id="' + tmp + '"]';
      }
      return {
        label: match.getAttribute('aria-label') || (match.textContent||'').trim().slice(0,80) || q,
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
        selector: sel
      };
    })(${JSON.stringify(query)})`,
    returnByValue: true
  }).catch(() => ({ result: { value: null } }));

  if (result && result.value) {
    const val = result.value as any;
    return {
      success: true,
      found: true,
      rect: { x: val.x, y: val.y, width: val.width, height: val.height },
      selector: val.selector,
      label: val.label
    };
  }

  return { success: true, found: false };
}
