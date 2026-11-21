import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { recordAction } from "../intelligence/trail.js";
import { confirmChange } from "../cdp/confirm.js";

import { getCachedActionMap, cacheActionMap } from "../state/cache.js";
import { sessionRegistry } from "../state/session.js";
import { getConfigAgentId } from "../config/loader.js";
import { buildActionMap, safeSelector } from "../cdp/walker.js";

export interface SelectOptions {
  nodeId?: number;
  selector?: string;
  ref?: string;
  id?: string;
  target?: string;
  value?: string;
  /** Multi-select values for <select multiple> or multi-option dropdowns. */
  values?: string[];
  /** 'option' (default) picks dropdown option(s); 'text' highlights text inside an element for copy/edit. */
  mode?: "option" | "text";
  /** Optional character range [start, end] when mode === 'text'. */
  start?: number;
  end?: number;
}

async function getSelector(session: CDP.Client, options: SelectOptions, config: Config): Promise<string> {
  if (options.selector) return options.selector;
  
  const targetRef = options.ref || options.id || options.target;
  if (targetRef) {
    const ref = targetRef;
    if (ref.startsWith("w:")) {
      return `[data-wt-id="${ref.slice(2)}"]`;
    }
    if (ref.startsWith("#") || ref.startsWith(".") || ref.startsWith("[")) {
      return ref;
    }

    let targetId = "default";
    const active = sessionRegistry.getActive(getConfigAgentId(config));
    if (active) targetId = active.targetId;

    const { frameTree } = await session.Page.getFrameTree();
    const url = frameTree.frame.url;

    let map = getCachedActionMap(targetId, url);
    if (!map) {
      map = await buildActionMap(session, { lite: true }, targetId);
      cacheActionMap(targetId, map);
    }

    const element = map.elements.find(el => el.id === ref || el.id === `w:${ref}` || el.label === ref);
    if (element) {
      const sel = safeSelector(element);
      if (sel) return sel;
    }
    return `[name="${ref}"], #${ref}, [aria-label="${ref}"]`;
  }

  if (options.nodeId) {
    const { nodeIds } = await session.DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [options.nodeId] });
    if (!nodeIds[0]) throw new Error("Node not found");
    const { object } = await session.DOM.resolveNode({ nodeId: nodeIds[0] });
    if (!object?.objectId) throw new Error("Could not resolve node");
    const { result } = await session.Runtime.callFunctionOn({
      objectId: object.objectId,
      functionDeclaration: `function() {
        if (this.id) return '#' + CSS.escape(this.id);
        if (this.name) return 'select[name="' + CSS.escape(this.name) + '"]';
        var idx = 0, el = this;
        while (el.previousElementSibling) { idx++; el = el.previousElementSibling; }
        var parent = this.parentElement;
        if (!parent) return 'select:last-of-type';
        var tag = this.tagName.toLowerCase();
        return tag + ':nth-child(' + (idx + 1) + ')';
      }`,
      returnByValue: true
    });
    return result.value as string;
  }
  throw new Error("browser_select requires either selector, nodeId, ref, target, or id");
}

function escapeSelector(sel: string): string {
  return JSON.stringify(sel);
}

export async function browserSelect(
  session: CDP.Client,
  options: SelectOptions,
  _config: Config
): Promise<{ success: boolean; message: string; value?: string; selected?: string | string[] }> {
  if (!options.selector && !options.nodeId && !options.ref && !options.id && !options.target) {
    throw new Error("browser_select requires either selector, nodeId, ref, target, or id");
  }

  const selector = await getSelector(session, options, _config);

  // ── TEXT / ELEMENT RANGE SELECTION MODE ────────────────────────────────────
  if (options.mode === "text") {
    const { result } = await session.Runtime.evaluate({
      expression: `(function(sel, start, end) {
        try {
          var el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
          if (!el) return JSON.stringify({ ok: false, error: 'Element not found' });
          if (typeof el.focus === 'function') el.focus();
          if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
            var s = typeof start === 'number' ? start : 0;
            var e = typeof end === 'number' ? end : el.value.length;
            el.setSelectionRange(s, e);
            return JSON.stringify({ ok: true, text: el.value.slice(s, e) });
          }
          var range = document.createRange();
          range.selectNodeContents(el);
          var selection = window.getSelection();
          if (selection) {
            selection.removeAllRanges();
            selection.addRange(range);
            return JSON.stringify({ ok: true, text: selection.toString() });
          }
          return JSON.stringify({ ok: false, error: 'Selection API unavailable' });
        } catch (err) {
          return JSON.stringify({ ok: false, error: err.message || String(err) });
        }
      })(${escapeSelector(selector)}, ${JSON.stringify(options.start ?? null)}, ${JSON.stringify(options.end ?? null)})`,
      returnByValue: true,
    });
    const parsed = JSON.parse((result?.value as string) || '{"ok":false,"error":"eval failed"}');
    if (!parsed.ok) throw new Error(parsed.error || "Text selection failed");
    recordAction({
      timestamp: new Date().toISOString(),
      tool: "browser_select",
      input: { ref: selector, mode: "text" },
      result: { success: true },
    });
    return {
      success: true,
      selected: parsed.text,
      message: `Selected ${String(parsed.text).length} chars in ${selector}`,
    };
  }

  const targetValues = options.values && options.values.length > 0
    ? options.values
    : options.value !== undefined ? [options.value] : [];
  if (targetValues.length === 0) {
    throw new Error("browser_select requires 'value' or 'values' (or mode: 'text')");
  }
  const value = targetValues[0]!;

  const getSelectState = async (): Promise<Record<string, string>> => {
    const { result } = await session.Runtime.evaluate({
      expression: `(function() {
        try {
          var el = document.querySelector(${escapeSelector(selector)});
          if (!el) return JSON.stringify({ exists: "false" });
          if (el.tagName === "SELECT") {
            var idx = el.selectedIndex;
            var opt = idx >= 0 ? el.options[idx] : null;
            var multiVals = el.multiple ? Array.from(el.selectedOptions || []).map(function(o){ return o.value; }).join(',') : el.value;
            return JSON.stringify({
              exists: "true",
              isNative: "true",
              selectedIndex: String(idx),
              value: multiVals,
              selectedText: opt ? opt.text : ""
            });
          }
          var text = (el.innerText || el.textContent || "").trim();
          var val = el.getAttribute("data-value") || el.getAttribute("aria-valuenow") || text;
          return JSON.stringify({
            exists: "true",
            isNative: "false",
            value: val,
            selectedText: text
          });
        } catch(e) {
          return JSON.stringify({ exists: "false", error: e.message });
        }
      })()`,
      returnByValue: true
    });
    return JSON.parse((result?.value as string) || '{}');
  };

  const action = async (): Promise<void> => {
    const { result } = await session.Runtime.evaluate({
      expression: `(function(selector, values) {
        try {
          const el = document.querySelector(selector);
          if (!el) return 'Element not found';

          if (el.tagName === 'SELECT') {
            if (el.multiple && values.length > 0) {
              var matched = 0;
              for (var i = 0; i < el.options.length; i++) {
                var o = el.options[i];
                var hit = values.some(function(v){ return o.value === v || o.text === v || o.text.trim() === v.trim(); });
                o.selected = hit;
                if (hit) matched++;
              }
              if (matched === 0) return 'Option not found in <select>: ' + values.join(', ');
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              return 'selected:multi:' + matched;
            }
            var value = values[0];
            let foundIndex = -1;
            for (let i = 0; i < el.options.length; i++) {
              const opt = el.options[i];
              if (opt.value === value || opt.text === value || opt.text.trim() === value.trim()) {
                foundIndex = i;
                break;
              }
            }
            if (foundIndex === -1) return 'Option not found in <select>: ' + value;

            el.selectedIndex = foundIndex;

            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(el, el.options[foundIndex].value);

            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            el.options[foundIndex].dispatchEvent(new MouseEvent('click', { bubbles: true }));

            return 'selected:' + el.selectedIndex;
          }

          // Custom ARIA / React / Radix / Shadcn dropdown — single click avoids toggle-close
          const isExpanded = el.getAttribute('aria-expanded') === 'true';
          if (!isExpanded) {
            el.click();
          }

          const optionSelectors = [
            '[role="option"]',
            '[role="menuitem"]',
            '[role="treeitem"]',
            '[data-radix-collection-item]',
            'li',
            '.option',
            '.select-option',
            '[data-value]'
          ];

          let candidates = Array.from(document.querySelectorAll(optionSelectors.join(',')));
          if (candidates.length === 0) {
            const containers = document.querySelectorAll('[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], .select-popover, .dropdown-menu');
            containers.forEach(c => {
              candidates.push(...Array.from(c.querySelectorAll('*')));
            });
          }

          let selectedCount = 0;
          for (const v of values) {
            const targetText = v.toLowerCase().trim();
            let matchedEl = null;
            for (const cand of candidates) {
              const text = (cand.innerText || cand.textContent || '').toLowerCase().trim();
              const valAttr = (cand.getAttribute('data-value') || cand.getAttribute('value') || '').toLowerCase().trim();
              if (text === targetText || valAttr === targetText || text.includes(targetText)) {
                matchedEl = cand;
                break;
              }
            }
            if (matchedEl) {
              matchedEl.click();
              selectedCount++;
            }
          }

          if (selectedCount === 0) {
            return 'Custom option not found: ' + values.join(', ');
          }

          return 'selected:custom';
        } catch (e) {
          return e.message || 'Unknown error';
        }
      })(${escapeSelector(selector)}, ${JSON.stringify(targetValues)})`,
      returnByValue: true
    });
    const resultVal = result?.value as string;
    if (!resultVal || (!resultVal.startsWith('selected:') && resultVal !== 'success')) {
      throw new Error(resultVal || 'Selection failed');
    }
  };

  const beforeState = await getSelectState();
  if (beforeState.exists === "false") {
    throw new Error("Element not found");
  }

  const confirm = await confirmChange(session, getSelectState, action, {
    verifyPasses: [16, 50, 200, 400],
  });

  if (confirm.applied) {
    recordAction({
      timestamp: new Date().toISOString(),
      tool: 'browser_select',
      input: { ref: selector, value: targetValues.length > 1 ? targetValues : value },
      result: { success: true, stuck: false },
    });
    return {
      success: true,
      value,
      selected: targetValues.length > 1 ? targetValues : value,
      message: `Selected value "${targetValues.join(", ")}" on ${beforeState.isNative === "true" ? "native <select>" : "custom UI dropdown"} (${confirm.attempts} attempts, settled ${confirm.settleMs}ms)`
    };
  }

  recordAction({
    timestamp: new Date().toISOString(),
    tool: 'browser_select',
    input: { ref: selector, value: targetValues.length > 1 ? targetValues : value },
    result: { success: false, stuck: true },
  });
  return {
    success: false,
    value,
    message: `Selection did not take effect. Before: value="${beforeState.value}". After: value="${confirm.after.value}".`
  };
}
