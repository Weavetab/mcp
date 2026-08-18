/**
 * Weavetab — tools/scrape.ts
 * browser_scrape: Rapid structured data extraction using CSS selectors/XPath.
 *
 * Secret containment: any element marked data-wt-secret or type="password" has
 * all requested attributes replaced with "[REDACTED]" in the returned result.
 * This is evaluated inside the in-page expression so the secret value never
 * crosses the CDP returnByValue boundary.
 *
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";

export interface ScrapeOptions {
  query: string;
  type?: "css" | "xpath";
  attributes?: string[]; // e.g. ["textContent", "href", "src"]
  multiple?: boolean;
}

export async function browserScrape(
  session: CDP.Client,
  options: ScrapeOptions,
  _config: Config
): Promise<{ success: boolean; data: any[]; message: string }> {
  const { query, type = "css", attributes = ["textContent"], multiple = true } = options;

  const res = await session.Runtime.evaluate({
    expression: `(function() {
      const results = [];
      let nodes = [];

      try {
        if (${JSON.stringify(type)} === 'css') {
          if (${multiple}) {
            nodes = Array.from(document.querySelectorAll(${JSON.stringify(query)}));
            // Shadow DOM fallback: if nothing found, try the extension's deep-shadow query helper.
            // This handles Vue/React components that attach to shadow roots.
            if (nodes.length === 0 && window.__Weavetab_shadowQuery_all) {
              try { nodes = Array.from(window.__Weavetab_shadowQuery_all(${JSON.stringify(query)})); } catch (_) {}
            }
          } else {
            const node = document.querySelector(${JSON.stringify(query)})
              || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(${JSON.stringify(query)}) : null);
            if (node) nodes = [node];
          }
        } else if (${JSON.stringify(type)} === 'xpath') {
          // Use SNAPSHOT type — immune to DOM mutations that would invalidate an ITERATOR mid-walk.
          const snap = document.evaluate(${JSON.stringify(query)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          const limit = ${multiple} ? snap.snapshotLength : Math.min(snap.snapshotLength, 1);
          for (let i = 0; i < limit; i++) {
            const n = snap.snapshotItem(i);
            // Only Element nodes expose getAttribute / tagName / outerHTML safely.
            if (n && n.nodeType === 1) nodes.push(n);
          }
        }
      } catch (e) {
        return { error: e.message };
      }

      const attrs = ${JSON.stringify(attributes)};
      nodes.forEach(node => {
        const item = {};

        // Secret containment: redact any element marked as sensitive.
        // data-wt-secret is set by browser_type_secret at injection time.
        const isSecret = node.hasAttribute && (
          node.hasAttribute('data-wt-secret') ||
          (node.tagName === 'INPUT' && node.type === 'password')
        );

        if (isSecret) {
          // Replace ALL requested attributes with [REDACTED] — value never crosses boundary
          attrs.forEach(attr => { item[attr] = '[REDACTED]'; });
        } else {
          attrs.forEach(attr => {
            if (attr === 'textContent' || attr === 'innerText') {
              item[attr] = node[attr]?.trim() || '';
            } else if (attr === 'outerHTML') {
              item[attr] = node.outerHTML;
            } else {
              item[attr] = node.getAttribute(attr) || node[attr] || '';
            }
          });
        }

        results.push(item);
      });

      const isXpath = ${JSON.stringify(type)} === 'xpath';
      const shadowFallback = !isXpath && nodes.length > 0 && !document.querySelector(${JSON.stringify(query)});
      return { data: results, usedShadowFallback: shadowFallback };
    })()`,
    returnByValue: true
  });

  let val = res.result?.value;
  if (val?.error) {
    throw new Error(`Scrape failed (type=${type}, query=${query}): ${val.error}`);
  }

  // Async-render retry: if 0 results found (CSS or XPath), wait 300ms and retry once.
  // Handles Vue transitions, React lazy rendering, and SPA route hydration.
  if (!val?.data || val.data.length === 0) {
    await new Promise(r => setTimeout(r, 300));

    // Build a fresh count expression depending on selector type.
    const countExpr = type === 'xpath'
      ? `(function(){
          try {
            var s = document.evaluate(${JSON.stringify(query)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            return s.snapshotLength;
          } catch(e) { return 0; }
        })()`
      : `(function(){
          var n = Array.from(document.querySelectorAll(${JSON.stringify(query)}));
          if (n.length === 0 && window.__Weavetab_shadowQuery_all) {
            try { n = Array.from(window.__Weavetab_shadowQuery_all(${JSON.stringify(query)})); } catch(_){}
          }
          return n.length;
        })()`;

    const retry = await session.Runtime.evaluate({ expression: countExpr, returnByValue: true }).catch(() => null);

    if (retry?.result?.value && retry.result.value > 0) {
      // Re-run full scrape now that elements exist.
      // XPath path uses snapshot; CSS path uses querySelectorAll + shadow fallback.
      const fullExpr = type === 'xpath'
        ? `(function(){
            var attrs = ${JSON.stringify(attributes)};
            var snap = document.evaluate(${JSON.stringify(query)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            var limit = ${multiple} ? snap.snapshotLength : Math.min(snap.snapshotLength, 1);
            var results = [];
            for (var i = 0; i < limit; i++) {
              var node = snap.snapshotItem(i);
              if (!node || node.nodeType !== 1) continue;
              var item = {};
              attrs.forEach(function(attr) {
                if (attr === 'textContent' || attr === 'innerText') { item[attr] = (node[attr] || '').trim(); }
                else if (attr === 'outerHTML') { item[attr] = node.outerHTML; }
                else { item[attr] = node.getAttribute ? (node.getAttribute(attr) || node[attr] || '') : ''; }
              });
              results.push(item);
            }
            return { data: results };
          })()`
        : `(function(){
            var nodes = Array.from(document.querySelectorAll(${JSON.stringify(query)}));
            if (nodes.length === 0 && window.__Weavetab_shadowQuery_all) {
              try { nodes = Array.from(window.__Weavetab_shadowQuery_all(${JSON.stringify(query)})); } catch(_){}
            }
            var attrs = ${JSON.stringify(attributes)};
            return { data: nodes.map(function(node) {
              var item = {};
              attrs.forEach(function(attr) {
                if (attr === 'textContent' || attr === 'innerText') { item[attr] = (node[attr] || '').trim(); }
                else if (attr === 'outerHTML') { item[attr] = node.outerHTML; }
                else { item[attr] = node.getAttribute(attr) || node[attr] || ''; }
              });
              return item;
            })};
          })()`;

      const res2 = await session.Runtime.evaluate({ expression: fullExpr, returnByValue: true }).catch(() => null);
      if (res2?.result?.value?.data) {
        val = res2.result.value;
      }
    }
  }

  return { success: true, data: val?.data || [], message: `Extracted ${val?.data?.length || 0} elements` };
}
