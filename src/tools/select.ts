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
  value: string;
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

    const element = map.elements.find(el => el.id === ref || el.label === ref || el.id.endsWith(ref.startsWith("w:") ? ref.slice(2) : ref));
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
      }()`,
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
): Promise<{ success: boolean; message: string; value?: string; selected?: string }> {
  if (!options.selector && !options.nodeId && !options.ref && !options.id && !options.target) {
    throw new Error("browser_select requires either selector, nodeId, ref, target, or id");
  }

  const selector = await getSelector(session, options, _config);
  const value = options.value;

  const getSelectState = async (): Promise<Record<string, string>> => {
    const { result } = await session.Runtime.evaluate({
      expression: `(function() {
        try {
          var el = document.querySelector(${escapeSelector(selector)});
          if (!el) return JSON.stringify({ exists: "false" });
          if (el.tagName === "SELECT") {
            var idx = el.selectedIndex;
            var opt = idx >= 0 ? el.options[idx] : null;
            return JSON.stringify({
              exists: "true",
              isNative: "true",
              selectedIndex: String(idx),
              value: el.value,
              selectedText: opt ? opt.text : ""
            });
          }
          // Custom UI Dropdown / Combobox / Popover
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
      expression: `(function(selector, value) {
        try {
          const el = document.querySelector(selector);
          if (!el) return 'Element not found';

          // ── NATIVE <select> ELEMENT ──────────────────────────────────────
          if (el.tagName === 'SELECT') {
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

          // ── CUSTOM ARIA / REACT / RADIX / SHADCN DROPDOWN ────────────────
          // 1. Open popover if closed
          const isExpanded = el.getAttribute('aria-expanded') === 'true';
          if (!isExpanded) {
            el.click();
            el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          }

          // 2. Scan options in open popover / listbox
          const targetText = value.toLowerCase().trim();
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
          // Fallback to all visible clickable items inside active popovers/listboxes
          if (candidates.length === 0) {
            const containers = document.querySelectorAll('[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], .select-popover, .dropdown-menu');
            containers.forEach(c => {
              candidates.push(...Array.from(c.querySelectorAll('*')));
            });
          }

          let matchedEl = null;
          for (const cand of candidates) {
            const text = (cand.innerText || cand.textContent || '').toLowerCase().trim();
            const valAttr = (cand.getAttribute('data-value') || cand.getAttribute('value') || '').toLowerCase().trim();
            if (text === targetText || valAttr === targetText || text.includes(targetText)) {
              matchedEl = cand;
              break;
            }
          }

          if (!matchedEl) {
            return 'Custom option not found: ' + value;
          }

          matchedEl.click();
          matchedEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
          matchedEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));

          return 'selected:custom';
        } catch (e) {
          return e.message || 'Unknown error';
        }
      })(${escapeSelector(selector)}, ${escapeSelector(value)})`,
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
      input: { ref: selector, value },
      result: { success: true, stuck: false },
    });
    return {
      success: true,
      value,
      selected: value,
      message: `Selected value "${value}" on ${beforeState.isNative === "true" ? "native <select>" : "custom UI dropdown"} (${confirm.attempts} attempts, settled ${confirm.settleMs}ms)`
    };
  }

  recordAction({
    timestamp: new Date().toISOString(),
    tool: 'browser_select',
    input: { ref: selector, value },
    result: { success: false, stuck: true },
  });
  return {
    success: false,
    value,
    message: `Selection did not take effect. Before: value="${beforeState.value}". After: value="${confirm.after.value}".`
  };
}
