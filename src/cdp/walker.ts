import { logDebug } from "../audit/logger.js";
import CDP from "chrome-remote-interface";
import * as FilterMod from "../security/filter.js";
import { SessionSecretTracker } from "../security/secrets.js";
import { getStoredRef, getStoredProps, type RefEntry } from "../state/delta.js";
import { getRawCachedActionMap } from "../state/cache.js";
import { getCachedConfig, getConfigExtension } from "../config/loader.js";

function cleanInvisibleText(text: string): string {
  if (!text) return text;
  if (typeof (FilterMod as any).stripInvisibleChars === "function") {
    return (FilterMod as any).stripInvisibleChars(text);
  }
  return text.replace(/[\u200B-\u200F\uFEFF\u00AD\u2060\u180E\u2028\u2029\u202A-\u202E\u2066-\u2069\u034F\uFE00-\uFE0E\u2000-\u200A\u{E0000}-\u{E007F}]/gu, "");
}

function applySecurityFilter(elements: ActionElement[]): ActionElement[] {
  const cleaned = elements.map((el) => ({
    ...el,
    label: cleanInvisibleText(el.label),
  }));
  if (typeof FilterMod.filterHidden === "function") {
    try {
      const res = (FilterMod.filterHidden as any)(cleaned);
      if (Array.isArray(res)) return res;
    } catch { /* fallback below */ }
  }
  return cleaned;
}

export type HrefType =
  | "same-origin" | "external" | "anchor" | "email" | "unknown";

export interface ActionElement {
  id: string;
  role: string;
  label: string;
  value?: string;
  backendNodeId?: number;
  selector?: string;
  group: "navigation" | "main_content" | "sidebar" | "form" | "modal" | "utility";
  type?: string;
  href?: string;
  hrefType?: HrefType;
  placeholder?: string;
  testId?: string;
  textContent?: string;
  className?: string;
  frameUrl?: string;
  fingerprint: string;
  isFixed?: boolean;
  disabled?: boolean;
  depth: number;
  x?: number;
  y?: number;
  viewport?: string;
  structuralIdiom?: string;
  containerContext?: string;
  isModal?: boolean;
  modalTitle?: string;
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
  scope?: ActionElement["group"] | string;
  query?: string;
  limit?: number;
  lite?: boolean;
  fast?: boolean;
  forDelta?: boolean;
  viewport?: { width: number; height: number; scrollX: number; scrollY: number };
  deep?: boolean;
  url?: string;
  title?: string;
  prune?: boolean;
}

let walkPassGlobalRefCounter = 1;

function beginWalkPass(): { passCounterBase: number; seenIds: Map<string, number> } {
  return {
    passCounterBase: walkPassGlobalRefCounter,
    seenIds: new Map<string, number>(),
  };
}

function allocateRefIds(count: number): number {
  const base = walkPassGlobalRefCounter;
  walkPassGlobalRefCounter += Math.max(count, 1);
  return base;
}

function dedupeRefId(id: string, seenIds: Map<string, number>): string {
  if (!seenIds.has(id)) {
    seenIds.set(id, 1);
    return id;
  }
  const next = seenIds.get(id)! + 1;
  seenIds.set(id, next);
  return dedupeRefId(`${id}_${next}`, seenIds);
}

const shadowDomCache = new Map<string, boolean>();

export function setShadowDomCache(targetId: string, hasShadow: boolean): void {
  shadowDomCache.set(targetId, hasShadow);
}

export function clearShadowDomCache(targetId?: string): void {
  if (targetId) {
    shadowDomCache.delete(targetId);
  } else {
    shadowDomCache.clear();
  }
}

export function clearViewportCache(_targetId?: string): void {}

export function resetFallbackIdCounter(): void {}

export function sanitizeElementIds(
  els: ActionElement[],
  counter: { value: number }
): number {
  let fixed = 0;
  for (const el of els) {
    if (!el.id || el.id === "w:undefined" || el.id === "w:null" || el.id === "w:") {
      el.id = `w:${counter.value++}`;
      fixed++;
    }
  }
  return fixed;
}

function isWeaveTabOverlay(label?: string, selector?: string): boolean {
  const lbl = label?.toLowerCase().trim() || "";
  const sel = selector?.toLowerCase() || "";
  const WT_LABELS = new Set([
    "chat with weavetab", "weavetab", "wt-msg-input", "wt-msg-send",
    "wt-msg-panel", "wt-ghost-cursor", "wt-ghost-bubble", "weavetab-tactical-overlay",
    "wt-shadow-host", "wt-chat-icon", "wt-chat-panel", "wt-chat-input",
    "f3", "toggle theme", "minimize", "send feedback..."
  ]);
  if (WT_LABELS.has(lbl)) return true;
  if (/^(chat with weavetab|weavetab hud|weave.*tab.*chat|send feedback|redirect, add a note, change goal|\u2191$|wt-(chat|shadow))/i.test(lbl)) return true;
  if (sel.includes("wt-shadow") || sel.includes("data-wt-ignore") || sel.startsWith("#wt-")) return true;
  return false;
}

export async function buildActionMap(
  session: CDP.Client,
  options: WalkerOptions = {},
  targetId = "default"
): Promise<ActionMap> {
  const { passCounterBase, seenIds: walkPassSeenIds } = beginWalkPass();
  const url = options.url ?? (await session.Page.getFrameTree()).frameTree.frame.url;

  const { sessionRegistry } = await import("../state/session.js");
  const client = sessionRegistry.getAll().find(c => c.targetId === targetId);

  let title = options.title;
  if (!title) {
    try {
      const evalRes = await session.Runtime.evaluate({
        expression: "document.title",
        returnByValue: true
      });
      if (evalRes?.result?.value) {
        title = String(evalRes.result.value);
      }
    } catch { /* ignore */ }
  }
  if (!title) {
    title = client?.title || "";
  }

  if (options.prune === undefined && client?.pruneActive) {
    options.prune = true;
  }

  const cfg = getCachedConfig();
  const skipExtension = Boolean(client?.isElectron) || !getConfigExtension(cfg);

  let extensionMap: any = null;
  if (!skipExtension) {
    const { getFromExtension } = await import("./helpers.js");
    extensionMap = await getFromExtension(session, { type: "GET_SEMANTIC_MAP" });

    if (extensionMap && Array.isArray(extensionMap)) {
      const invalidCount = extensionMap.filter(
        (el: any) => el.id === undefined || el.id === null || el.id === ""
      ).length;
      if (invalidCount > 0) {
        logDebug(`[Walker] Extension returned ${invalidCount}/${extensionMap.length} elements with invalid IDs, forcing CDP fallback`);
        extensionMap = null;
      }
    }

    if (extensionMap && Array.isArray(extensionMap) && extensionMap.length > 0) {
      const sampleSize = Math.min(5, extensionMap.length);
      const sampleIds = (extensionMap as any[]).slice(0, sampleSize).map((el: any) => el.id).filter(Boolean);
      if (sampleIds.length > 0) {
        try {
          const { result: domVerify } = await session.Runtime.evaluate({
            expression: `(function(ids) {
              return ids.filter(function(id) {
                return !document.querySelector('[data-wt-id="' + String(id).replace(/["\\\\]/g, '\\\\$&') + '"]');
              }).length;
            })(${JSON.stringify(sampleIds)})`,
            returnByValue: true
          });
          const missingCount = (domVerify?.value as number) ?? sampleIds.length;
          if (missingCount > Math.ceil(sampleIds.length / 2)) {
            logDebug(`[Walker] Extension ID DOM verification: ${missingCount}/${sampleIds.length} IDs not found in DOM — falling through to CDP fallback`);
            extensionMap = null;
          }
        } catch { /* non-fatal */ }
      }
    }

    if (!extensionMap || !Array.isArray(extensionMap)) {
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
          if (parsed.source === "live-index" && parsed.elements && Array.isArray(parsed.elements)) {
            logDebug(`[Walker] read ${parsed.elements.length} elements from extension live index`);
            extensionMap = parsed.elements;
          }
        } catch (e) {
          logDebug(`[Walker] Failed to parse live index result: ${e}`);
        }
      }
    }
  }

  if (!extensionMap || !Array.isArray(extensionMap)) {
    const { result } = await session.Runtime.evaluate({
      expression: `(function() {
        var INTERACTIVE_SEL = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"], [role="menuitem"], [role="tab"], [tabindex]:not([tabindex="-1"])';

        function deepQuery(root, selector, visited, depth) {
          if (!visited) visited = new Set();
          if (depth === undefined) depth = 0;
          if (depth > 10) return [];
          if (visited.has(root)) return [];
          visited.add(root);
          var all = [];
          try {
            var direct = root.querySelectorAll(selector);
            for (var i = 0; i < direct.length; i++) all.push(direct[i]);
          } catch (e) {}
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
        var useDeep = ${JSON.stringify(!!options.deep)} || hasShadowCache;
        var els = [];
        var flatEls;

        if (!hasShadowCache) {
          try {
            flatEls = document.querySelectorAll(INTERACTIVE_SEL);
            for (var fi = 0; fi < flatEls.length; fi++) els.push(flatEls[fi]);
          } catch (e) {}
        }

        if (useDeep || els.length < 3) {
          try {
            var deepEls = deepQuery(document, INTERACTIVE_SEL);
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

        function wtHashId(el, rect) {
          var tag = el.tagName || '';
          var role = el.getAttribute('role') || '';
          var text = (el.getAttribute('aria-label') || el.textContent || el.value || el.placeholder || '').slice(0, 60).trim();
          var absX = Math.round(rect.left + (window.scrollX || 0));
          var absY = Math.round(rect.top + (window.scrollY || 0));
          var pathStr = '';
          try {
            var curr = el;
            for (var level = 0; level < 3 && curr; level++) {
              var p = curr.parentElement;
              if (!p) break;
              var idx = 0;
              var siblings = p.children;
              for (var si = 0; si < siblings.length; si++) {
                if (siblings[si] === curr) { idx = si; break; }
              }
              pathStr += '|' + (curr.tagName || '') + '[' + idx + ']';
              curr = p;
            }
          } catch(e) {}
          var raw = tag + '|' + role + '|' + text + '|' + absX + '|' + absY + pathStr;
          var h = 5381;
          for (var ci = 0; ci < raw.length; ci++) {
            h = ((h << 5) + h) ^ raw.charCodeAt(ci);
            h = h >>> 0;
          }
          return 'wt' + h.toString(36);
        }

        var usedHashes = {};
        var collisionCounter = ${JSON.stringify(passCounterBase)};
        var _coIdx = 0;
        var results = [];
        var pendingAttrWrites = [];

        for (var i2 = 0; i2 < els.length; i2++) {
          try {
            var el = els[i2];
            if (el.closest('[data-wt-ignore]') !== null) continue;
            var rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
            var id = el.getAttribute('data-wt-id');
            if (!id) {
              var hid = wtHashId(el, rect);
              if (usedHashes[hid]) {
                hid = hid + '_' + (collisionCounter++);
              }
              usedHashes[hid] = true;
              id = hid;
              pendingAttrWrites.push([el, id]);
            }
            var role = el.tagName.toLowerCase();
            if (role === 'a') role = 'link';
            else if (role === 'input' && (el.type === 'text' || el.type === 'search')) role = 'textbox';
            var frameUrl = '';
            try { if (el.ownerDocument !== document) frameUrl = el.ownerDocument.defaultView.location.href; } catch(e) { frameUrl = 'cross-origin-' + (_coIdx++); }
            var secretRegex = /password|passcode|pin|passphrase|secret|token|auth.?key|access.?code|mot.?de.?passe|contrase[nñ]a|kennwort|senha/i;
            var isSecret = el.hasAttribute('data-wt-secret') ||
              ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && (
                el.type === 'password' ||
                secretRegex.test(el.getAttribute('autocomplete') || '') ||
                secretRegex.test(el.getAttribute('name') || '') ||
                secretRegex.test(el.getAttribute('id') || '') ||
                secretRegex.test(el.getAttribute('aria-label') || '')
              ));
            var richPh = el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder') || (el.querySelector ? (el.querySelector('[data-slate-placeholder]')?.textContent || '') : '') || '';
            var labelStr = el.getAttribute('aria-label') || el.innerText || (isSecret ? '' : el.value) || richPh || '';
            var elType = (el.type || '').toLowerCase();
            var elRole = (el.getAttribute('role') || el.tagName.toLowerCase());
            var isCheckable = elType === 'radio' || elType === 'checkbox' ||
                              elRole === 'radio' || elRole === 'checkbox';
            var isOption = el.tagName === 'OPTION';
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

            var idiom = '';
            var CONTROLS_ATTRS = ['aria-controls', 'aria-owns', 'data-target', 'data-bs-target'];
            for (var ca = 0; ca < CONTROLS_ATTRS.length; ca++) {
              if (el.hasAttribute(CONTROLS_ATTRS[ca])) {
                idiom = CONTROLS_ATTRS[ca];
                break;
              }
            }

            var containerCtx = '';
            try {
              var CARD_SEL = '[class*="card"],[class*="row"],[class*="item"],[class*="product"],[class*="plan"],[class*="entry"],[class*="result"],[class*="tile"],[class*="option"],[data-entity]';
              var ancestor = el.parentElement;
              var depth3 = 0;
              while (ancestor && depth3 < 8) {
                if (ancestor.matches && ancestor.matches(CARD_SEL)) {
                  var heading = ancestor.querySelector('h1,h2,h3,h4,h5,h6,[class*="title"],[class*="name"],[class*="heading"],[class*="label"]');
                  if (heading) {
                    var hText = (heading.innerText || heading.textContent || '').trim().slice(0, 60);
                    if (hText && hText !== labelStr) { containerCtx = hText; break; }
                  }
                  var allText = (ancestor.innerText || ancestor.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
                  if (allText && allText !== labelStr) { containerCtx = allText; break; }
                }
                ancestor = ancestor.parentElement;
                depth3++;
              }
            } catch(e) {}

            var inModal = false;
            var modalTitleStr = '';
            try {
              var MODAL_SEL = 'dialog[open],[role="dialog"],[aria-modal="true"],[class*="modal"],[class*="overlay"],[class*="drawer"]';
              var modalAnc = el.parentElement;
              var md = 0;
              while (modalAnc && md < 15) {
                if (modalAnc.matches && modalAnc.matches(MODAL_SEL)) {
                  inModal = true;
                  var mh = modalAnc.querySelector('h1,h2,h3,h4,[class*="title"]');
                  if (mh) {
                    var lbId = modalAnc.getAttribute('aria-labelledby');
                    var lbEl = lbId ? document.getElementById(lbId) : null;
                    modalTitleStr = ((lbEl || mh).innerText || (lbEl || mh).textContent || '').trim().slice(0, 60);
                  }
                  break;
                }
                modalAnc = modalAnc.parentElement;
                md++;
              }
            } catch(e) {}

            results.push({
              id: String(id),
              role: el.getAttribute('role') || role,
              type: elType || undefined,
              label: labelStr,
              placeholder: el.placeholder || richPh || undefined,
              value: valStr,
              x: Math.round(rect.left + rect.width / 2),
              y: Math.round(rect.top + rect.height / 2),
              selector: '[data-wt-id="' + id + '"]',
              href: el.href,
              textContent: txtContent,
              className: el.className || '',
              frameUrl: frameUrl,
              structuralIdiom: idiom || undefined,
              containerContext: containerCtx || undefined,
              isModal: inModal || undefined,
              modalTitle: modalTitleStr || undefined,
              disabled: (el.disabled || el.getAttribute('aria-disabled') === 'true') || undefined,
              checked: isCheckable ? el.checked : undefined,
            });
          } catch (e) {}
        }

        for (var wi = 0; wi < pendingAttrWrites.length; wi++) {
          try { pendingAttrWrites[wi][0].setAttribute('data-wt-id', pendingAttrWrites[wi][1]); } catch (e) {}
        }

        return JSON.stringify({ elements: results, shadowFound: results.length > 0 && typeof flatEls !== 'undefined' && els.length > flatEls.length });
      })()`,
      returnByValue: true
    });
    if (result && result.value) {
      try {
        const parsed = JSON.parse(result.value as string);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.elements) {
          extensionMap = parsed.elements;
          if (parsed.shadowFound) {
            shadowDomCache.set(targetId, true);
          }
        } else {
          extensionMap = parsed;
        }
      } catch {
        extensionMap = [];
      }
    }
  }

  try {
    const { getOmniSessions } = await import("./omni_broker.js");
    const childSessions = getOmniSessions(targetId);
    if (childSessions && childSessions.size > 0) {
      let frameOrigins: Array<{ url: string; left: number; top: number }> = [];
      try {
        const { result: frameRectsRes } = await session.Runtime.evaluate({
          expression: `(function() {
            var frames = document.querySelectorAll('iframe, webview');
            var out = [];
            for (var i = 0; i < frames.length; i++) {
              var f = frames[i];
              var r = f.getBoundingClientRect();
              out.push({ url: f.src || f.getAttribute('src') || '', left: Math.round(r.left), top: Math.round(r.top) });
            }
            return JSON.stringify(out);
          })()`,
          returnByValue: true,
        });
        if (frameRectsRes?.value) {
          frameOrigins = JSON.parse(frameRectsRes.value as string);
        }
      } catch { /* best-effort frame offset */ }

      for (const [, childSession] of childSessions.entries()) {
        try {
          const { result: childResult } = await childSession.Runtime.evaluate({
            expression: `(function() {
              var INTERACTIVE_SEL = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"], [role="menuitem"], [role="tab"], [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
              var els = document.querySelectorAll(INTERACTIVE_SEL);
              var secretRegex = /password|passcode|pin|passphrase|secret|token|auth.?key|access.?code|mot.?de.?passe|contrase[nñ]a|kennwort|senha/i;
              var usedHashes = {};
              var results = [];
              var pendingWrites = [];

              function wtHashId(el, rect) {
                var tag = el.tagName || '';
                var role = el.getAttribute('role') || '';
                var text = (el.getAttribute('aria-label') || el.textContent || el.value || el.placeholder || '').slice(0, 60).trim();
                var raw = 'wv|' + tag + '|' + role + '|' + text + '|' + Math.round(rect.left) + '|' + Math.round(rect.top);
                var h = 5381;
                for (var ci = 0; ci < raw.length; ci++) {
                  h = ((h << 5) + h) ^ raw.charCodeAt(ci);
                  h = h >>> 0;
                }
                return 'wv' + h.toString(36);
              }

              for (var i = 0; i < els.length; i++) {
                var el = els[i];
                var rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > window.innerHeight) continue;
                var id = el.getAttribute('data-wt-id');
                if (!id) {
                  var hid = wtHashId(el, rect);
                  if (usedHashes[hid]) {
                    var c = ++usedHashes[hid];
                    hid = hid + '_' + c;
                  } else {
                    usedHashes[hid] = 1;
                  }
                  id = hid;
                  pendingWrites.push([el, id]);
                }
                var isSecret = el.hasAttribute('data-wt-secret') ||
                  ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && (
                    el.type === 'password' ||
                    secretRegex.test(el.getAttribute('autocomplete') || '') ||
                    secretRegex.test(el.getAttribute('name') || '') ||
                    secretRegex.test(el.getAttribute('id') || '') ||
                    secretRegex.test(el.getAttribute('aria-label') || '')
                  ));
                var labelStr = el.getAttribute('aria-label') || el.innerText || (isSecret ? '' : el.value) || el.placeholder || '';
                var valStr = el.value !== undefined ? String(el.value) : undefined;
                if (isSecret) {
                  labelStr = el.getAttribute('aria-label') || el.placeholder || '[REDACTED SECRET FIELD]';
                  if (valStr !== undefined) valStr = '[REDACTED]';
                }
                results.push({
                  id: id,
                  role: el.getAttribute('role') || el.tagName.toLowerCase(),
                  label: labelStr,
                  value: valStr,
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2),
                  selector: '[data-wt-id="' + id + '"]',
                  frameUrl: window.location.href,
                });
              }
              for (var w = 0; w < pendingWrites.length; w++) {
                try { pendingWrites[w][0].setAttribute('data-wt-id', pendingWrites[w][1]); } catch(e) {}
              }
              return JSON.stringify(results);
            })()`,
            returnByValue: true,
          });
          if (childResult && childResult.value) {
            const childEls = JSON.parse(childResult.value as string);
            if (Array.isArray(childEls) && childEls.length > 0) {
              const fUrl = childEls[0]?.frameUrl || "";
              const matchedFrame = frameOrigins.find(fo => fo.url && (fUrl === fo.url || fUrl.startsWith(fo.url) || fo.url.startsWith(fUrl))) || frameOrigins[0];
              const offsetX = matchedFrame ? matchedFrame.left : 0;
              const offsetY = matchedFrame ? matchedFrame.top : 0;
              for (const ce of childEls) {
                if (typeof ce.x === "number") ce.x += offsetX;
                if (typeof ce.y === "number") ce.y += offsetY;
              }
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

  const mappedElements: ActionElement[] = extensionMap.map((el: any) => ({
    id: `w:${el.id}`,
    role: el.role || el.tag || "generic",
    label: el.label || el.text || el.placeholder || "",
    value: el.value,
    placeholder: el.placeholder || undefined,
    type: el.type || undefined,
    group: "main_content",
    fingerprint: `${el.role || el.tag || "generic"}:${el.label || el.text || ""}:${el.id}`,
    depth: 0,
    x: el.x ?? (el.coords ? el.coords.x : undefined),
    y: el.y ?? (el.coords ? el.coords.y : undefined),
    viewport: el.viewport,
    href: el.href,
    selector: el.selector,
    backendNodeId: undefined,
    textContent: el.textContent || undefined,
    className: el.className || el.attributes?.class || "",
    structuralIdiom: el.structuralIdiom || undefined,
    frameUrl: el.frameUrl || undefined,
    containerContext: el.containerContext || undefined,
    isModal: el.isModal || undefined,
    modalTitle: el.modalTitle || undefined,
    disabled: el.disabled || undefined,
  }));

  let invalidIdCount = 0;
  const usedFallbackHashes = new Set<string>();
  for (let i = 0; i < mappedElements.length; i++) {
    if (!mappedElements[i].id || mappedElements[i].id === "w:undefined" || mappedElements[i].id === "w:null" || mappedElements[i].id === "w:") {
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
      mappedElements[i].id = `w:f${hash}`;
      mappedElements[i].fingerprint = `${mappedElements[i].role}:${mappedElements[i].label}:fb-${hash}`;
      invalidIdCount++;
    }
  }
  if (invalidIdCount > 0) {
    logDebug(`[Walker] Post-mapping sanitizer fixed ${invalidIdCount} element(s) with stable fallback IDs`);
  }

  for (const el of mappedElements) {
    const original = el.id;
    const deduped = dedupeRefId(el.id, walkPassSeenIds);
    if (deduped !== original) {
      el.id = deduped;
      logDebug(`[Walker] Bug#5 cross-frame dedup: ${original} → ${el.id}`);
    }
  }

  const visibleElements = mappedElements.filter((el) => {
    if (isWeaveTabOverlay(el.label, el.selector)) return false;
    const lbl = el.label?.toLowerCase().trim() || "";
    if (!lbl && !el.value && !el.placeholder && !el.href &&
        (el.role === "generic" || el.role === "" || el.role === "div")) return false;
    return true;
  });

  let prunedElements = visibleElements;
  if (options.prune) {
    try {
      const { loadDomainProfile } = await import("../intelligence/sessionMemory.js");
      let hostname = "local";
      try {
        hostname = new URL(url).hostname || "local";
      } catch {
        hostname = "local";
      }
      const profile = await loadDomainProfile(hostname);
      const structuralIdioms = profile?.memories
        .filter(m => m.state !== "deprecated" && m.fingerprint?.structuralIdiom)
        .map(m => m.fingerprint!.structuralIdiom!) || [];

      const uniqueIdioms = Array.from(new Set(structuralIdioms));

      const { pruneSnapshot } = await import("./pruner.js");
      prunedElements = await pruneSnapshot(session, visibleElements, targetId, uniqueIdioms);
    } catch (e) {
      logDebug(`[Walker] Pruner threw — falling back to unpruned list: ${e}`);
      prunedElements = visibleElements;
    }
  }

  let scopedElements = prunedElements;
  if (options.scope) {
    const GROUP_SELECTOR_MAP: Record<string, string> = {
      navigation: "nav, header, [role='navigation'], [role='banner']",
      main_content: "main, article, [role='main']",
      sidebar: "aside, [role='complementary']",
      form: "form, [role='form']",
      modal: "dialog[open], [role='dialog'], [aria-modal='true']",
      utility: "footer, [role='contentinfo']",
    };
    const effectiveScopeSel = GROUP_SELECTOR_MAP[options.scope] || options.scope;

    const { result: scopeResult } = await session.Runtime.evaluate({
      expression: `(function(sel) {
        try {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const ids = [...el.querySelectorAll('[data-wt-id]')].map(e => e.getAttribute('data-wt-id')).filter(Boolean);
          return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, ids: ids };
        } catch(e) { return null; }
      })(${JSON.stringify(effectiveScopeSel)})`,
      returnByValue: true,
    }).catch(() => ({ result: { value: null } }));
    const scopeData = scopeResult?.value as { left: number; top: number; right: number; bottom: number; ids: string[] } | null;
    if (scopeData) {
      const validIds = new Set(scopeData.ids);
      scopedElements = prunedElements.filter(el => {
        if (validIds.has(el.id.replace("w:", ""))) return true;
        if (el.x !== undefined && el.y !== undefined) {
          return el.x >= scopeData.left && el.x <= scopeData.right &&
                 el.y >= scopeData.top && el.y <= scopeData.bottom;
        }
        return false;
      });
    }
  }

  let filtered = applySecurityFilter(scopedElements);

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

  if (options.limit && filtered.length > options.limit) {
    filtered = filtered.slice(0, options.limit);
  }

  const redactedElements = filtered.map(el => ({
    ...el,
    label: targetId ? SessionSecretTracker.redact(targetId, el.label) : el.label,
    value: el.value !== undefined ? (targetId ? SessionSecretTracker.redact(targetId, el.value) : el.value) : undefined,
    placeholder: el.placeholder ? (targetId ? SessionSecretTracker.redact(targetId, el.placeholder) : el.placeholder) : undefined,
    textContent: el.textContent ? (targetId ? SessionSecretTracker.redact(targetId, el.textContent) : el.textContent) : undefined,
  }));

  return { url, title, elements: redactedElements, targetId };
}

export function toRefEntries(elements: ActionElement[]): RefEntry[] {
  return elements.map((el) => ({
    id: el.id,
    role: el.role,
    label: el.label,
    type: el.type,
    href: el.href,
    disabled: el.disabled ?? false,
    value: el.value,
    fingerprint: el.fingerprint,
  }));
}

export function findAllMatches(
  elements: ActionElement[],
  query: string
): ActionElement[] {
  if (!query || !query.trim()) return [];
  const n = (str?: string) => (str || "").toLowerCase().replace(/[\.\u2026\s]+/g, " ").trim();
  const q = n(query);

  const matches: ActionElement[] = [];
  const seenMatchIds = new Set<string>();
  const addMatch = (el: ActionElement | undefined) => {
    if (el && !seenMatchIds.has(el.id)) {
      seenMatchIds.add(el.id);
      matches.push(el);
    }
  };

  elements.forEach(el => { if (n(el.label) === q) addMatch(el); });

  const qStripped = q.replace(/^[#@]/, "");
  if (qStripped !== q) {
    elements.forEach(el => {
      const elLabelClean = n(el.label).replace(/^[#@]/, "");
      if (elLabelClean === qStripped) addMatch(el);
    });
  }

  elements.forEach(el => { if (n(el.placeholder) === q || n(el.placeholder) === qStripped) addMatch(el); });

  elements.forEach(el => { if (n(el.testId) === q) addMatch(el); });

  elements.forEach(el => {
    const lbl = n(el.label);
    if (lbl.includes(q) || (qStripped.length >= 3 && lbl.includes(qStripped))) addMatch(el);
  });

  const words = q.split(/\s+/);
  if (words.length > 1) {
    elements.forEach(el => { if (words.every(w => n(el.label).includes(w))) addMatch(el); });
  }

  const qLowRaw = query.trim().toLowerCase();
  elements.forEach(el => { if (el.type && el.type.toLowerCase() === qLowRaw) addMatch(el); });

  return matches;
}

export function findBestMatch(
  elements: ActionElement[],
  query: string
): ActionElement | undefined {
  const matches = findAllMatches(elements, query);
  return matches.length > 0 ? matches[0] : undefined;
}

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
      function escapeAttr(val) {
        return String(val).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/\\n/g, '\\\\n').replace(/\\r/g, '');
      }
      var qLow = norm(q);

      function score(el) {
        try { return el.querySelector(INTERACTIVE) !== null ? 10 : 0; } catch(e) { return 0; }
      }
      function makeResult(el) {
        if (!el) return null;
        var r = el.getBoundingClientRect();
        if (!r || r.width === 0 || r.height === 0) return null;
        if (r.bottom < 0 || r.top > window.innerHeight) return null;
        var sel = '';
        var wtId = el.getAttribute('data-wt-id');
        if (wtId) {
          sel = '[data-wt-id="' + escapeAttr(wtId) + '"]';
        } else if (el.id) {
          try { sel = '#' + CSS.escape(el.id); } catch(e) { sel = '[id="' + escapeAttr(el.id) + '"]'; }
        } else {
          var aria = el.getAttribute('aria-label');
          if (aria) sel = el.tagName.toLowerCase() + '[aria-label="' + escapeAttr(aria) + '"]';
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
      function pickFirstVisible(list) {
        if (!list || !list.length) return null;
        var scored = [];
        for (var idx = 0; idx < list.length; idx++) {
          scored.push({ el: list[idx], s: score(list[idx]) });
        }
        scored.sort(function(a, b) { return a.s - b.s; });
        for (var j = 0; j < scored.length; j++) {
          var hit = makeResult(scored[j].el);
          if (hit) return hit;
        }
        return null;
      }

      var all, found, i, hit;

      all = document.querySelectorAll('[aria-label]');
      found = [];
      for (i=0;i<all.length;i++) {
        if (norm(all[i].getAttribute('aria-label'))===qLow) found.push(all[i]);
      }
      if (found.length) { hit=pickFirstVisible(found); if(hit) return hit; }

      found = [];
      for (i=0;i<all.length;i++) {
        var aVal = norm(all[i].getAttribute('aria-label'));
        if (aVal.indexOf(qLow)>=0 && aVal.length < qLow.length*4) found.push(all[i]);
      }
      if (found.length) { hit=pickFirstVisible(found); if(hit) return hit; }

      all = document.querySelectorAll(INTERACTIVE);
      found = [];
      for (i=0;i<all.length;i++) {
        var t = norm(all[i].innerText||all[i].textContent);
        if (t===qLow) found.push(all[i]);
      }
      if (found.length) { hit=pickFirstVisible(found); if(hit) return hit; }

      all = document.querySelectorAll('[placeholder],[data-placeholder],[aria-placeholder],[data-slate-placeholder]');
      found = [];
      for (i=0;i<all.length;i++) {
        var phVal = norm(all[i].getAttribute('placeholder') || all[i].getAttribute('data-placeholder') || all[i].getAttribute('aria-placeholder') || all[i].textContent);
        if (phVal===qLow || phVal.indexOf(qLow)>=0) found.push(all[i]);
      }
      if (found.length) { hit=pickFirstVisible(found); if(hit) return hit; }

      all = document.querySelectorAll('[title],[alt]');
      found = [];
      for (i=0;i<all.length;i++) {
        var v = norm(all[i].getAttribute('title')||all[i].getAttribute('alt'));
        if (v===qLow) found.push(all[i]);
      }
      if (found.length) { hit=pickFirstVisible(found); if(hit) return hit; }

      all = document.querySelectorAll(INTERACTIVE);
      found = [];
      for (i=0;i<all.length;i++) {
        var t5 = norm(all[i].innerText||all[i].textContent);
        if (t5.indexOf(qLow)>=0 && t5.length < qLow.length*4) found.push(all[i]);
      }
      if (found.length) { hit=pickFirstVisible(found); if(hit) return hit; }

      return null;
    })(${JSON.stringify(query)})`,
    returnByValue: true,
  }).catch(() => null);

  const val = resp?.result?.value as { label: string; x: number; y: number; selector: string } | null;
  if (!val) return null;
  return { id: "aria-fallback", label: cleanInvisibleText(val.label), x: val.x, y: val.y, selector: val.selector };
}

const AX_TREE_CACHE_MAX = 50;
const AX_TREE_TTL_MS = 10_000;
const axTreeCache = new Map<string, { map: ActionMap; timestamp: number }>();

export function clearAXTreeCache(_targetId?: string): void {
  axTreeCache.clear();
}

function axTreeCacheGet(url: string): ActionMap | null {
  const entry = axTreeCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > AX_TREE_TTL_MS) {
    axTreeCache.delete(url);
    return null;
  }
  return entry.map;
}

function axTreeCacheSet(url: string, map: ActionMap): void {
  if (axTreeCache.size >= AX_TREE_CACHE_MAX && !axTreeCache.has(url)) {
    const firstKey = axTreeCache.keys().next().value;
    if (firstKey !== undefined) axTreeCache.delete(firstKey);
  }
  axTreeCache.set(url, { map, timestamp: Date.now() });
}

const INTERACTIVE_AX_ROLES = new Set([
  "button", "link", "textbox", "combobox", "checkbox", "radio",
  "slider", "tab", "menuitem", "searchbox", "switch", "spinbutton",
  "treeitem", "listbox", "option", "menuitemcheckbox", "menuitemradio",
  "scrollbar", "tabpanel", "tree", "treegrid", "alert", "dialog",
  "tooltip", "status", "timer",
]);

const NOISE_AX_ROLES = new Set([
  "generic", "inlinetextbox", "statictext", "paragraph", "heading",
  "list", "listitem", "none", "presentation", "row", "cell",
  "grid", "group", "region", "document", "rootwebarea",
]);

export async function buildAXTreeMap(
  session: CDP.Client,
  _options: WalkerOptions = {},
  targetId = "default"
): Promise<ActionMap> {
  const { seenIds: walkPassSeenIds } = beginWalkPass();

  const { frameTree } = await session.Page.getFrameTree();
  const url = frameTree.frame.url;
  const title = frameTree.frame.name || url || "";

  const cached = axTreeCacheGet(url);
  if (cached && cached.elements.length > 0) {
    return cached;
  }

  try {
    await session.Accessibility.enable();
  } catch { /* already enabled */ }

  let nodes: any[] = [];
  try {
    const result = await session.Accessibility.getFullAXTree();
    nodes = result?.nodes ?? [];
  } catch {
    return { url, title, elements: [], targetId };
  }

  const candidates = nodes.filter((n: any) => {
    if (n.ignored) return false;
    const role = (n.role?.value || "").toLowerCase();
    if (!role || NOISE_AX_ROLES.has(role)) return false;
    return INTERACTIVE_AX_ROLES.has(role) || n.name?.value || n.value?.value;
  });

  const axIdBase = allocateRefIds(candidates.length);
  let axIdCursor = axIdBase;
  const elements: ActionElement[] = [];

  for (const node of candidates) {
    const role = (node.role?.value || "generic").toLowerCase();
    let label = cleanInvisibleText(node.name?.value || node.description?.value || "");

    let value: string | undefined;
    if (role === "radio" || role === "checkbox" || role === "menuitemcheckbox" || role === "menuitemradio") {
      const checked = node.properties?.find((p: any) => p.name === "checked")?.value?.value;
      value = checked === true || checked === "true" ? "true" : "false";
    } else if (role === "option") {
      const selected = node.properties?.find((p: any) => p.name === "selected")?.value?.value;
      value = selected === true || selected === "true" ? "true" : "false";
    } else {
      value = node.value?.value !== undefined ? String(node.value.value) : undefined;
    }

    const SECRET_TERMS = /password|passcode|pin|passphrase|secret|token|auth.?key|access.?code|mot.?de.?passe|contrase[nñ]a|kennwort|senha|пароль|密碼|密码/i;
    const isSecretRole = role === "password" || SECRET_TERMS.test(node.name?.value || "") || SECRET_TERMS.test(node.description?.value || "");
    if (isSecretRole || (node.backendDOMNodeId !== undefined && SessionSecretTracker.isNodeSecret(targetId, node.backendDOMNodeId))) {
      label = "[REDACTED]";
      value = "[REDACTED]";
    } else {
      label = targetId ? SessionSecretTracker.redact(targetId, label) : label;
      if (value !== undefined) value = targetId ? SessionSecretTracker.redact(targetId, value) : value;
    }
    const id = dedupeRefId(`w:${axIdCursor++}`, walkPassSeenIds);

    elements.push({
      id,
      role,
      label,
      value,
      backendNodeId: node.backendDOMNodeId,
      group: "main_content",
      fingerprint: `ax:${role}:${label || ""}:${axIdCursor}`,
      depth: 0,
    });
  }

  const filteredElements = applySecurityFilter(
    elements.filter(el => !isWeaveTabOverlay(el.label, el.selector))
  );

  const byBackendId = new Map<number, ActionElement>();
  const backendIdsToResolve: number[] = [];
  for (const el of filteredElements) {
    if (el.backendNodeId !== undefined && !byBackendId.has(el.backendNodeId)) {
      byBackendId.set(el.backendNodeId, el);
      backendIdsToResolve.push(el.backendNodeId);
    }
  }

  if (backendIdsToResolve.length > 0) {
    try {
      const { nodeIds } = await session.DOM.pushNodesByBackendIdsToFrontend({
        backendNodeIds: backendIdsToResolve,
      });
      if (nodeIds) {
        const CHUNK_SIZE = 16;
        for (let start = 0; start < nodeIds.length; start += CHUNK_SIZE) {
          const slice = nodeIds.slice(start, start + CHUNK_SIZE);
          await Promise.all(slice.map(async (nodeId, offset) => {
            if (!nodeId) return;
            try {
              const { model } = await session.DOM.getBoxModel({ nodeId });
              if (model?.content) {
                const content = model.content;
                const cx = Math.round((content[0] + content[4]) / 2);
                const cy = Math.round((content[1] + content[5]) / 2);
                const backendId = backendIdsToResolve[start + offset];
                const el = backendId !== undefined ? byBackendId.get(backendId) : undefined;
                if (el) {
                  el.x = cx;
                  el.y = cy;
                }
              }
            } catch { /* detached node */ }
          }));
        }
      }
    } catch { /* coordinate resolution best-effort */ }
  }

  const map: ActionMap = { url, title, elements: filteredElements, targetId };
  axTreeCacheSet(url, map);
  return map;
}

export interface RecoveredRefResult {
  recovered: boolean;
  element?: ActionElement;
  strategy?: "connected_existing" | "stored_selector" | "exact_label" | "placeholder_or_name" | "fuzzy_label";
  warning?: string;
}

function safeClassSelector(className?: string): string | undefined {
  if (!className || typeof className !== "string") return undefined;
  const firstToken = className.trim().split(/\s+/)[0];
  if (!firstToken) return undefined;
  const escaped = firstToken.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
  return `.${escaped}`;
}

export async function recoverDetachedRef(
  session: CDP.Client,
  targetId: string,
  ref: string,
  preferredCandidate?: Partial<ActionElement>
): Promise<RecoveredRefResult> {
  const refNumericId = ref.replace(/^w:/, "");

  const storedRef = getStoredRef(targetId, ref);
  const storedProps = getStoredProps(targetId, ref);
  const rawMap = getRawCachedActionMap(targetId);
  const cachedEl = rawMap?.elements?.find(e => e.id === ref || e.id === `w:${refNumericId}`);

  const candidateLabel = preferredCandidate?.label || storedProps?.label || storedRef?.label || cachedEl?.label || "";
  const candidatePlaceholder = preferredCandidate?.placeholder || storedProps?.placeholder || cachedEl?.placeholder || "";
  const candidateRole = preferredCandidate?.role || storedProps?.role || storedRef?.role || cachedEl?.role || "";
  const candidateSelector = preferredCandidate?.selector || cachedEl?.selector || safeClassSelector(storedProps?.className);
  const candidateText = preferredCandidate?.textContent || storedProps?.textContent || cachedEl?.textContent || "";

  const meta = {
    label: candidateLabel === "[REDACTED]" || candidateLabel === "[REDACTED SECRET FIELD]" ? "" : candidateLabel,
    placeholder: candidatePlaceholder === "[REDACTED]" ? "" : candidatePlaceholder,
    role: candidateRole,
    selector: candidateSelector,
    textContent: candidateText === "[REDACTED]" ? "" : candidateText,
  };

  try {
    const { result } = await session.Runtime.evaluate({
      expression: `(function(refId, meta) {
        var secretRegex = /password|passcode|pin|passphrase|secret|token|auth.?key|access.?code|mot.?de.?passe|contrase[nñ]a|kennwort|senha/i;
        function isSecretEl(el) {
          if (!el || !el.tagName) return false;
          if (el.hasAttribute && el.hasAttribute('data-wt-secret')) return true;
          var tag = el.tagName.toLowerCase();
          if (tag === 'input' || tag === 'textarea') {
            var t = (el.getAttribute('type') || '').toLowerCase();
            var ac = (el.getAttribute('autocomplete') || '').toLowerCase();
            var name = (el.getAttribute('name') || '').toLowerCase();
            var id = (el.getAttribute('id') || '').toLowerCase();
            var aria = (el.getAttribute('aria-label') || '').toLowerCase();
            return t === 'password' || ac.includes('password') || secretRegex.test(name) || secretRegex.test(id) || secretRegex.test(aria);
          }
          return false;
        }
        function extractSafeLabel(el) {
          if (isSecretEl(el)) {
            return el.getAttribute('aria-label') || el.placeholder || '[REDACTED SECRET FIELD]';
          }
          return el.getAttribute('aria-label') || (el.innerText || el.textContent || '').trim() || el.placeholder || '';
        }

        var escapedRefId = String(refId).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
        var existing = document.querySelector('[data-wt-id="' + escapedRefId + '"]');
        if (existing && existing.isConnected) {
          var r = existing.getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return {
              success: true,
              strategy: 'connected_existing',
              x: Math.round(r.left + r.width / 2),
              y: Math.round(r.top + r.height / 2),
              label: extractSafeLabel(existing),
              role: existing.getAttribute('role') || existing.tagName.toLowerCase()
            };
          }
        }

        function isValidCandidate(el) {
          if (!el || !el.isConnected) return false;
          var r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return false;
          try {
            var style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') return false;
          } catch(e) {}
          return true;
        }

        if (meta.selector && !meta.selector.startsWith('[data-wt-id')) {
          try {
            var el = document.querySelector(meta.selector);
            if (isValidCandidate(el)) {
              el.setAttribute('data-wt-id', refId);
              var r2 = el.getBoundingClientRect();
              return {
                success: true,
                strategy: 'stored_selector',
                x: Math.round(r2.left + r2.width / 2),
                y: Math.round(r2.top + r2.height / 2),
                label: extractSafeLabel(el),
                role: el.getAttribute('role') || el.tagName.toLowerCase()
              };
            }
          } catch(e) {}
        }

        var normLabel = (meta.label || '').toLowerCase().trim();
        var normPlaceholder = (meta.placeholder || '').toLowerCase().trim();

        var rawCandidates = Array.from(document.querySelectorAll(
          'button, a, input, select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="tab"], [tabindex="0"]'
        ));
        var validCandidates = [];
        for (var vi = 0; vi < rawCandidates.length; vi++) {
          if (isValidCandidate(rawCandidates[vi])) validCandidates.push(rawCandidates[vi]);
        }

        if (normLabel) {
          for (var ci = 0; ci < validCandidates.length; ci++) {
            var c = validCandidates[ci];
            var aria = (c.getAttribute('aria-label') || '').toLowerCase().trim();
            var text = ((c.innerText || c.textContent || '')).toLowerCase().trim();
            var val = isSecretEl(c) ? '' : (c.value || '').toLowerCase().trim();
            var placeholder = (c.placeholder || '').toLowerCase().trim();
            var name = (c.getAttribute('name') || '').toLowerCase().trim();

            if (aria === normLabel || text === normLabel || placeholder === normLabel || name === normLabel || (val && val === normLabel)) {
              c.setAttribute('data-wt-id', refId);
              var rc = c.getBoundingClientRect();
              return {
                success: true,
                strategy: 'exact_label',
                x: Math.round(rc.left + rc.width / 2),
                y: Math.round(rc.top + rc.height / 2),
                label: extractSafeLabel(c),
                role: c.getAttribute('role') || c.tagName.toLowerCase()
              };
            }
          }
        }

        if (normPlaceholder) {
          for (var pi = 0; pi < validCandidates.length; pi++) {
            var cp = validCandidates[pi];
            var ph = (cp.placeholder || '').toLowerCase().trim();
            var nm = (cp.getAttribute('name') || '').toLowerCase().trim();
            if (ph === normPlaceholder || nm === normPlaceholder) {
              cp.setAttribute('data-wt-id', refId);
              var rp = cp.getBoundingClientRect();
              return {
                success: true,
                strategy: 'placeholder_or_name',
                x: Math.round(rp.left + rp.width / 2),
                y: Math.round(rp.top + rp.height / 2),
                label: extractSafeLabel(cp),
                role: cp.getAttribute('role') || cp.tagName.toLowerCase()
              };
            }
          }
        }

        if (normLabel && normLabel.length >= 3) {
          var bestMatch = null;
          var minDiff = Infinity;
          for (var fi = 0; fi < validCandidates.length; fi++) {
            var cf = validCandidates[fi];
            var fText = ((cf.innerText || cf.textContent || '')).toLowerCase().trim();
            var fAria = (cf.getAttribute('aria-label') || '').toLowerCase().trim();
            var candStr = fAria || fText;
            if (candStr && candStr.includes(normLabel)) {
              var diff = candStr.length - normLabel.length;
              if (diff >= 0 && diff < minDiff) {
                minDiff = diff;
                bestMatch = cf;
              }
            }
          }
          if (bestMatch) {
            bestMatch.setAttribute('data-wt-id', refId);
            var rb = bestMatch.getBoundingClientRect();
            return {
              success: true,
              strategy: 'fuzzy_label',
              x: Math.round(rb.left + rb.width / 2),
              y: Math.round(rb.top + rb.height / 2),
              label: extractSafeLabel(bestMatch),
              role: bestMatch.getAttribute('role') || bestMatch.tagName.toLowerCase()
            };
          }
        }

        return { success: false };
      })(${JSON.stringify(refNumericId)}, ${JSON.stringify(meta)})`,
      returnByValue: true,
    });

    const res = result?.value as any;
    if (res && res.success) {
      const rawRecoveredLabel = cleanInvisibleText(res.label || candidateLabel || "recovered-element");
      const safeLabel = targetId ? SessionSecretTracker.redact(targetId, rawRecoveredLabel) : rawRecoveredLabel;

      const recoveredElement: ActionElement = {
        id: ref.startsWith("w:") ? ref : `w:${ref}`,
        role: res.role || candidateRole || "button",
        label: safeLabel,
        x: res.x,
        y: res.y,
        selector: `[data-wt-id="${refNumericId.replace(/["\\]/g, "\\$&")}"]`,
        group: "utility",
        depth: 0,
        fingerprint: `${res.role || candidateRole}:${safeLabel}`,
      };

      if (rawMap && rawMap.elements) {
        const existingIdx = rawMap.elements.findIndex(e => e.id === recoveredElement.id);
        if (existingIdx !== -1) {
          rawMap.elements[existingIdx] = recoveredElement;
        } else {
          rawMap.elements.push(recoveredElement);
        }
      }

      return {
        recovered: true,
        element: recoveredElement,
        strategy: res.strategy,
        warning: `(Auto-recovered detached ref '${ref}' via ${res.strategy}: '${recoveredElement.label}')`,
      };
    }
  } catch (err) {
    logDebug(`[Walker] Detached ref recovery failed for ${ref}: ${err}`);
  }

  return { recovered: false };
}
