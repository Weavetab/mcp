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
import { getConfigAgentId } from "../config/loader.js";
import { SessionSecretTracker } from "../security/secrets.js";
import { sessionRegistry } from "../state/session.js";

export interface ScrapeOptions {
  query: string;
  type?: "css" | "xpath";
  attributes?: string[]; // e.g. ["textContent", "href", "src"]
  multiple?: boolean;
}

function buildScrapeExpr(
  query: string,
  type: "css" | "xpath",
  attributes: string[],
  multiple: boolean
): string {
  return `(function() {
      const results = [];
      let nodes = [];

      try {
        if (${JSON.stringify(type)} === 'css') {
          if (${multiple}) {
            nodes = Array.from(document.querySelectorAll(${JSON.stringify(query)}));
            if (nodes.length === 0 && window.__Weavetab_shadowQuery_all) {
              try { nodes = Array.from(window.__Weavetab_shadowQuery_all(${JSON.stringify(query)})); } catch (_) {}
            }
          } else {
            const node = document.querySelector(${JSON.stringify(query)})
              || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(${JSON.stringify(query)}) : null);
            if (node) nodes = [node];
          }
        } else if (${JSON.stringify(type)} === 'xpath') {
          const snap = document.evaluate(${JSON.stringify(query)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          const limit = ${multiple} ? snap.snapshotLength : Math.min(snap.snapshotLength, 1);
          for (let i = 0; i < limit; i++) {
            const n = snap.snapshotItem(i);
            if (n && n.nodeType === 1) nodes.push(n);
          }
        }
      } catch (e) {
        return { error: e.message };
      }

      const attrs = ${JSON.stringify(attributes)};
      var secretRegex = /password|passcode|pin|passphrase|secret|token|auth.?key|access.?code|mot.?de.?passe|contrase[nñ]a|kennwort|senha/i;
      nodes.forEach(node => {
        const item = {};

        const isSecret = node.hasAttribute && (
          node.hasAttribute('data-wt-secret') ||
          (node.tagName === 'INPUT' && (
            node.type === 'password' ||
            secretRegex.test(node.getAttribute('autocomplete') || '') ||
            secretRegex.test(node.getAttribute('name') || '') ||
            secretRegex.test(node.getAttribute('id') || '') ||
            secretRegex.test(node.getAttribute('aria-label') || '')
          ))
        );

        if (isSecret) {
          attrs.forEach(attr => { item[attr] = '[REDACTED]'; });
        } else {
          attrs.forEach(attr => {
            if (attr === 'textContent' || attr === 'innerText') {
              item[attr] = node[attr]?.trim() || '';
            } else if (attr === 'outerHTML') {
              item[attr] = node.outerHTML;
            } else if (attr === 'value') {
              item[attr] = node.value !== undefined ? String(node.value) : '';
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
    })()`;
}

export async function browserScrape(
  session: CDP.Client,
  options: ScrapeOptions,
  _config: Config
): Promise<{ success: boolean; data: any[]; message: string }> {
  const { query, type = "css", attributes = ["textContent"], multiple = true } = options;
  const expr = buildScrapeExpr(query, type, attributes, multiple);

  const res = await session.Runtime.evaluate({ expression: expr, returnByValue: true });

  let val = res.result?.value;
  if (val?.error) {
    throw new Error(`Scrape failed (type=${type}, query=${query}): ${val.error}`);
  }

  // Async-render retry: if 0 results found, wait 300ms and re-run the exact same expression
  if (!val?.data || val.data.length === 0) {
    await new Promise(r => setTimeout(r, 300));
    const res2 = await session.Runtime.evaluate({ expression: expr, returnByValue: true }).catch(() => null);
    if (res2?.result?.value?.data) {
      val = res2.result.value;
    }
  }

  let targetId = "default";
  const active = sessionRegistry.getActive(getConfigAgentId(_config));
  if (active) targetId = active.targetId;

  const rawData = (val?.data || []) as Record<string, any>[];
  const sanitizedData = rawData.map(item => {
    const sanitizedItem: Record<string, any> = {};
    for (const [k, v] of Object.entries(item)) {
      sanitizedItem[k] = typeof v === 'string' ? SessionSecretTracker.redact(targetId, v) : v;
    }
    return sanitizedItem;
  });

  return { success: true, data: sanitizedData, message: `Extracted ${sanitizedData.length} elements` };
}
