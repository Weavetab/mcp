/**
 * Weavetab — tools/find.ts
 * browser_find: DEPRECATED — prefer browser_click with action:'find' which uses the same
 * resolution chain but with memory-intercept and URC cache for 10x faster results.
 * This shim is kept for backward compatibility only.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";
import { SessionSecretTracker } from "../security/secrets.js";
import { sessionRegistry } from "../state/session.js";

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
  const { query, role, all = false, limit = 10 } = options;

  if (!query) throw new Error("browser_find requires a query string");

  const targetId = sessionRegistry.getActive(getConfigAgentId(_config))?.targetId ?? "default";

  const { result } = await session.Runtime.evaluate({
    expression: `(function(q, roleFilter, returnAll, maxMatches) {
      function norm(s) { return (s || '').toLowerCase().replace(/[.\\u2026\\s]+/g, ' ').trim(); }
      var root = document.body || document.documentElement;
      if (!root) return null;
      var qLow = norm(q);
      var roleLow = roleFilter ? roleFilter.toLowerCase().trim() : '';
      function matchesRole(el) {
        if (!roleLow) return true;
        var explicit = (el.getAttribute('role') || '').toLowerCase();
        if (explicit === roleLow) return true;
        var tag = (el.tagName || '').toLowerCase();
        if (roleLow === 'link' && tag === 'a') return true;
        if (roleLow === 'button' && (tag === 'button' || (tag === 'input' && (el.type === 'submit' || el.type === 'button')))) return true;
        if (roleLow === 'textbox' && (tag === 'textarea' || tag === 'input')) return true;
        return tag === roleLow;
      }
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null, false);
      var matchedNodes = [];
      var seenElements = new Set();

      var ignoredTags = new Set(['style', 'script', 'noscript', 'template']);
      while (walker.nextNode()) {
        var node = walker.currentNode;
        if (node.nodeType === Node.TEXT_NODE) {
          var t = norm(node.nodeValue);
          if (t && t.includes(qLow)) {
            var p = node.parentElement;
            if (p && !seenElements.has(p) && matchesRole(p)) {
              var pTag = p.tagName ? p.tagName.toLowerCase() : '';
              if (ignoredTags.has(pTag)) continue;
              if (p.closest && p.closest('#wt-shadow-host, [data-wt-ignore], weavetab-host')) continue;
              seenElements.add(p);
              matchedNodes.push(p);
              if (!returnAll && matchedNodes.length >= 1) break;
              if (matchedNodes.length >= maxMatches) break;
            }
          }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          var el = node;
          if (seenElements.has(el) || !matchesRole(el)) continue;
          var elTag = el.tagName ? el.tagName.toLowerCase() : '';
          if (ignoredTags.has(elTag)) continue;
          if (el.closest && el.closest('#wt-shadow-host, [data-wt-ignore], weavetab-host')) continue;
          var aria = norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '');
          if (aria && aria.includes(qLow)) {
            seenElements.add(el);
            matchedNodes.push(el);
            if (!returnAll && matchedNodes.length >= 1) break;
            if (matchedNodes.length >= maxMatches) break;
          }
        }
      }

      if (matchedNodes.length === 0) return null;

      var out = matchedNodes.map(function(match) {
        var r = match.getBoundingClientRect();
        var wtId = match.getAttribute('data-wt-id');
        var sel = '';
        if (wtId) {
          sel = '[data-wt-id="' + wtId + '"]';
        } else if (match.id) {
          sel = '#' + CSS.escape(match.id);
        } else {
          var path = [];
          var curr = match;
          while (curr && curr.nodeType === Node.ELEMENT_NODE && curr !== document.body && curr !== document.documentElement) {
            var tag = curr.tagName.toLowerCase();
            if (curr.id) {
              path.unshift('#' + CSS.escape(curr.id));
              break;
            }
            var p = curr.parentElement;
            if (p) {
              var sibs = Array.from(p.children).filter(function(c) { return c.tagName === curr.tagName; });
              if (sibs.length > 1) {
                tag += ':nth-of-type(' + (sibs.indexOf(curr) + 1) + ')';
              }
            }
            path.unshift(tag);
            curr = p;
          }
          sel = path.join(' > ') || match.tagName.toLowerCase();
        }
        return {
          ref: wtId ? ('w:' + wtId) : undefined,
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
    })(${JSON.stringify(query)}, ${JSON.stringify(role ?? "")}, ${JSON.stringify(all)}, ${JSON.stringify(limit)})`,
    returnByValue: true
  }).catch(() => ({ result: { value: null } }));

  if (result && result.value) {
    const list: any[] = JSON.parse((result.value as string) || '[]');
    if (list.length > 0) {
      const sanitized = list.map(m => ({
        ref: m.ref,
        selector: m.selector,
        label: SessionSecretTracker.redact(targetId, String(m.label ?? "")),
        tag: m.tag,
        rect: { x: m.x, y: m.y, width: m.width, height: m.height }
      }));
      const first = sanitized[0]!;
      return {
        success: true,
        found: true,
        total_matches: sanitized.length,
        matches: sanitized,
        rect: first.rect,
        selector: first.selector,
        label: first.label
      };
    }
  }

  return { success: true, found: false, total_matches: 0, matches: [] };
}
