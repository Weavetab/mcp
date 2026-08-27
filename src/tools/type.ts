import { logDebug } from "../audit/logger.js";
// src/tools/type.ts
// Priority 2: Sub-10ms Typing Path & Predictive Action Queue

import CDP from "chrome-remote-interface";
import { buildActionMap, findBestMatch, findAllMatches, toRefEntries, safeSelector, toMarkdownTable, resolveByAria } from "../cdp/walker.js";
import { checkDomain } from "../security/blacklist.js";
import { logAction } from "../audit/logger.js";
import { recordAction, detectLoop, getLoopDiagnostics, trackToolCall, detectStuckLoop } from "../intelligence/trail.js";
import { waitForDOMStable } from "../sensors/guard.js";
import { waitForNetworkIdle } from "../sensors/wait.js";
import { ghostType, ghostMove, waitForReading, ghostClick } from "../overlay/ghost.js";
import { cacheActionMap, getCachedActionMap } from "../state/cache.js";
import { storeSnapshot, computeRichDelta } from "../state/delta.js";
import { sessionRegistry } from "../state/session.js";
import { saveDomainProfile, getBestSelectorForIntent, logMemorySuccess, logMemoryFailure, loadDomainProfile } from "../intelligence/sessionMemory.js";
import type { Config } from "../config/loader.js";
import { getConfigAgentId, getConfigHeadless } from "../config/loader.js";
import type { WeaveError } from "./click.js";
import { sendToExtension } from "../cdp/helpers.js";
import { appendKnowledgeHint } from "../intelligence/hints.js";
import { verifyActionability, quickHitCheck } from "../sensors/actionability.js";

export interface TypeResult {
  success: true;
  typed_into: string;
  ref: string;
  length: number;
  execution_ms: number;
  tab_id: string;
  url: string;
  title: string;
  /** Only present when include_map:true was passed or url_changed is true. */
  page_map?: string;
  /** true if any DOM elements changed after typing. */
  dom_changed: boolean;
  /** true if dom_changed is false — the page did not respond to this action. */
  stuck_warning: boolean;
  /** Guidance when stuck_warning is true. */
  stuck_hint?: string;
  /** Sniper warning if multiple matches were found. */
  sniper_warning?: string;
  /** true if a high-confidence memory hit was used; false/absent if DOM was resolved normally. */
  memory_hit?: boolean;
  /** Rich delta showing exactly what changed */
  delta?: any;
  /** SEMANTIC RESPONSE CONTRACT FIELDS */
  confirmed: boolean; // Was the effect verified in DOM, not just dispatched
  strategy: string; // What method was used (e.g., "direct", "coordinates", "aria")
  elementState?: Record<string, unknown>; // Element's full state after action
  visibleFeedback?: string[]; // Any validation/toast text that appeared
  suggestedNext?: string; // What the agent should likely do next
}

interface ResolvedTarget {
  backendNodeId?: number;
  objectId?: string;
  label: string;
  ref: string;
  x?: number;
  y?: number;
  selector?: string;
  structuralIdiom?: string;
}

/**
 * Detect the JavaScript framework used by the current page
 * This helps determine the best input event strategy
 */
export async function detectFramework(session: CDP.Client): Promise<'react' | 'vue' | 'angular' | 'vanilla'> {
  try {
    const { result } = await session.Runtime.evaluate({
      expression: `(function() {
        const root = document.documentElement;
        if (root.__reactFiber || root._reactRootContainer || window.React || window.react) return 'react';
        if (root.__vue__ || document.querySelector('[data-v-]') || window.Vue || window.vue) return 'vue';
        if (root.ng || document.querySelector('[ng-version]') || window.angular || window.ng) return 'angular';
        return 'vanilla';
      })()`,
      returnByValue: true,
    });
    return result?.value || 'vanilla';
  } catch {
    return 'vanilla';
  }
}

async function focusEditable(session: CDP.Client, objectId: string, clearFirst?: boolean, fast = false): Promise<void> {
  const { Input } = session;
  await session.Runtime.callFunctionOn({
    functionDeclaration: `async function() {
      if (this.scrollIntoViewIfNeeded) this.scrollIntoViewIfNeeded();
      else {
        this.scrollIntoView({behavior:'smooth',block:'center'});
        await new Promise(r => setTimeout(r, ${fast ? 50 : 400}));
      }
      this.focus();
      this.click();
    }`,
    objectId,
    silent: true,
    awaitPromise: true,
  });

  if (clearFirst) {
    await session.Runtime.callFunctionOn({
      functionDeclaration: `function() {
        if (typeof this.select === 'function') this.select();
        else if (this.isContentEditable) {
          this.textContent = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          this.value = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }`,
      objectId,
      silent: true,
    });
    await Input.dispatchKeyEvent({ type: "keyDown", key: "Delete", nativeVirtualKeyCode: 46, windowsVirtualKeyCode: 46 });
    await Input.dispatchKeyEvent({ type: "keyUp", key: "Delete", nativeVirtualKeyCode: 46, windowsVirtualKeyCode: 46 });
  }
}

/**
 * Framework-aware text injection.
 * React/Vue controlled inputs require the native prototype setter + InputEvent
 * to trigger synthetic event reconciliation. Firing a plain Event('input') AFTER
 * an insertText causes a second state update — the source of triplication.
 *
 * Returns true when the native-setter path was taken (caller skips redundant
 * post-type event dispatch).
 */
export async function frameworkAwareType(
  session: CDP.Client,
  objectId: string,
  text: string,
  framework: 'react' | 'vue' | 'angular' | 'vanilla'
): Promise<boolean> {
  const { Input, Runtime } = session;

  if (framework === 'react' || framework === 'vue') {
    // Use native prototype setter so React/Vue synthetic reconciler sees the
    // change as coming from the user, not an external mutation.
    // One InputEvent with inputType:'insertText' is what React 16/17/18 listens
    // for — the old `.simulated = true` trick only worked in React <16 and is a
    // no-op in modern React (Event properties are frozen after construction).
    await Runtime.callFunctionOn({
      functionDeclaration: `function(text) {
        const nativeInputSetter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value'
        )?.set;
        const nativeTextAreaSetter = Object.getOwnPropertyDescriptor(
          window.HTMLTextAreaElement.prototype, 'value'
        )?.set;

        if (this.tagName === 'INPUT' && nativeInputSetter) {
          nativeInputSetter.call(this, text);
        } else if (this.tagName === 'TEXTAREA' && nativeTextAreaSetter) {
          nativeTextAreaSetter.call(this, text);
        } else if (this.isContentEditable) {
          this.textContent = text;
        } else {
          this.value = text;
        }

        // Single InputEvent with inputType:'insertText' — React 16/17/18 SyntheticEvent
        // source. Do NOT also dispatch a plain Event('input') here; that would
        // fire the onChange handler a second time and duplicate the value.
        this.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text,
        }));
        this.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      }`,
      objectId,
      arguments: [{ value: text }],
      silent: true,
      awaitPromise: true,
    });
    // Signal to caller: native-setter path taken — caller must NOT re-dispatch events
    return true;
  } else {
    // For vanilla JS / Angular: standard CDP engine-level text insertion
    await Input.insertText({ text });
    return false;
  }
}

async function resolveTypingTarget(
  session: CDP.Client,
  map: Awaited<ReturnType<typeof buildActionMap>>,
  args: { id?: string; label?: string; intent?: string; backendNodeId?: number },
  _targetId: string
): Promise<ResolvedTarget | null> {
  const { id, label, intent, backendNodeId: directNodeId } = args;
  const { DOM } = session;

  if (directNodeId) {
    const resolved = await DOM.resolveNode({ backendNodeId: directNodeId }).catch(() => null);
    const objectId = resolved?.object?.objectId;
    return {
      backendNodeId: directNodeId,
      objectId,
      label: `node-${directNodeId}`,
      ref: `node-${directNodeId}`,
    };
  }

  let element = id ? map.elements.find((el) => el.id === id || el.id.endsWith(id)) : undefined;
  // Fast-fail: w:NN IDs not in the current map are stale. Return immediately.
  if (!element && id && id.startsWith("w:")) {
    return {
      success: false,
      error_code: "ELEMENT_NOT_FOUND",
      message: `[!] Ref '${id}' not found in the current page map. The page may have updated. Call browser_map() to get fresh ref IDs.`,
    } as any;
  }
  if (!element && id && !id.startsWith("w:")) {
    try {
      const checkEl = await session.Runtime.evaluate({
        expression: `(function(){
          const el = document.querySelector(${JSON.stringify(id)}) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(${JSON.stringify(id)}) : null);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {
            label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || 'selector-match',
            x: Math.round(r.left + r.width / 2),
            y: Math.round(r.top + r.height / 2)
          };
        })()`,
        returnByValue: true
      });
      if (checkEl?.result?.value) {
        const val = checkEl.result.value;
        element = {
          id: id,
          label: val.label,
          x: val.x,
          y: val.y,
          selector: id,
          role: "textbox",
          group: "utility",
          depth: 0,
          fingerprint: "selector:" + id,
        } as any;
      }
    } catch (e) {
      logDebug("Failed raw selector resolve", e);
    }
  }
  if (!element && label) element = findBestMatch(map.elements, label) ?? undefined;
  if (!element && intent) element = findBestMatch(map.elements, intent) ?? undefined;

  if (element) {
    if (element.backendNodeId) {
      const { nodeIds } = await DOM.pushNodesByBackendIdsToFrontend({ backendNodeIds: [element.backendNodeId] }).catch(() => ({ nodeIds: [] }));
      let objectId: string | undefined;
      let x = element.x;
      let y = element.y;
      if (nodeIds[0]) {
        const resolved = await DOM.resolveNode({ nodeId: nodeIds[0] }).catch(() => null);
        objectId = resolved?.object?.objectId;
        if (x === undefined || y === undefined) {
          const box = await DOM.getBoxModel({ nodeId: nodeIds[0] }).catch(() => null);
          if (box?.model?.content) {
            const q = box.model.content;
            x = q[0]! + (q[2]! - q[0]!) / 2;
            y = q[1]! + (q[5]! - q[1]!) / 2;
          }
        }
      }
      return { backendNodeId: element.backendNodeId, objectId, label: element.label, ref: element.id, x, y, selector: safeSelector(element), structuralIdiom: element.structuralIdiom };
    } else {
      return { label: element.label, ref: element.id, x: element.x, y: element.y, selector: safeSelector(element), structuralIdiom: element.structuralIdiom };
    }
  }

  // ARIA fallback before DOM heuristic
  if (!element && (label || intent)) {
    const ariaMatch = await resolveByAria(session, label || intent || "");
    if (ariaMatch) {
      return {
        backendNodeId: undefined,
        objectId: undefined,
        label: ariaMatch.label,
        ref: ariaMatch.id,
        x: ariaMatch.x,
        y: ariaMatch.y,
        selector: ariaMatch.selector,
      };
    }
  }

  // If a specific target was requested (id, label, or intent) but ALL resolution
  // paths above failed, return null — do NOT fall through to the generic
  // activeElement/largest-field heuristic. Falling through causes consecutive
  // type() calls to silently write into the same focused element, producing
  // cross-contaminated values.
  if (id || label || intent) {
    return null;
  }

  const active = await session.Runtime.evaluate({
    expression: `(function(){
      const pick = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) return null;
        if (r.bottom < 0 || r.top > innerHeight) return null;
        return {
          label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || (el.textContent||'').trim().slice(0,40) || 'input',
          selector: ['textarea[name="q"]','input[name="q"]','[aria-label="Search"]','[title="Search"]','input[type="search"]','textarea','input[type="text"]','input:not([type])','[role="combobox"]','[role="textbox"]','[contenteditable="true"]','[contenteditable=""]'].find(function(s){try{return el.matches(s)}catch(e){return false}}) || '',
          x: Math.round(r.left + r.width/2),
          y: Math.round(r.top + r.height/2)
        };
      };
      var sel;
      sel = 'textarea[name="q"], input[name="q"], [aria-label="Search"], [title="Search"]';
      var q = document.querySelector(sel);
      var fromQ = pick(q);
      if (fromQ) return JSON.stringify(fromQ);
      var el = document.activeElement;
      var isEditable = el && (
        el.isContentEditable ||
        el.tagName === 'TEXTAREA' ||
        (el.tagName === 'INPUT' && !['button','submit','checkbox','radio','hidden','file'].includes((el.type||'').toLowerCase()))
      );
      if (isEditable) return JSON.stringify(pick(el));
      var sels = ['[contenteditable="true"]','[contenteditable=""]','textarea','input[type="search"]','input[type="text"]','input:not([type])','[role="textbox"]','[role="combobox"]','input[name="q"]'];
      var best = null, bestArea = 0;
      for (var si = 0; si < sels.length; si++) {
        var nodes = document.querySelectorAll(sels[si]);
        for (var ni = 0; ni < nodes.length; ni++) {
          var r = nodes[ni].getBoundingClientRect();
          var area = r.width * r.height;
          if (area > bestArea && r.top >= 0 && r.top < innerHeight) { bestArea = area; best = nodes[ni]; }
        }
      }
      if (!best) return null;
      return JSON.stringify(pick(best));
    })()`,
    returnByValue: true,
  }).catch(() => null);

  const raw = active?.result?.value as string | null | undefined;
  if (!raw || raw === "null") return null;

  const parsed = JSON.parse(raw) as { label: string; selector?: string; x: number; y: number };
  if (!parsed || parsed.x === undefined || parsed.y === undefined) return null;

  // Try DOM.querySelector first (more reliable than getNodeForLocation for overlays)
  if (parsed.selector) {
    try {
      const { root } = await DOM.getDocument().catch(() => ({ root: null as any }));
      if (root?.nodeId) {
        const docResult = await DOM.querySelector({ nodeId: root.nodeId, selector: parsed.selector });
        if (docResult?.nodeId) {
          const resolvedNode = await DOM.resolveNode({ nodeId: docResult.nodeId }).catch(() => null);
          const described = await DOM.describeNode({ nodeId: docResult.nodeId }).catch(() => null);
          return {
            backendNodeId: described?.node?.backendNodeId,
            objectId: resolvedNode?.object?.objectId,
            label: parsed.label,
            ref: "focused",
            x: parsed.x,
            y: parsed.y,
          };
        }
      }
    } catch { /* DOM.querySelector failed, fallback to getNodeForLocation */ }
  }

  const loc = await DOM.getNodeForLocation({ x: parsed.x, y: parsed.y }).catch(() => null);
  if (!loc?.nodeId) return { label: parsed.label, ref: "focused", x: parsed.x, y: parsed.y };

  const resolvedNode = await DOM.resolveNode({ nodeId: loc.nodeId }).catch(() => null);
  const described = await DOM.describeNode({ nodeId: loc.nodeId }).catch(() => null);
  return {
    backendNodeId: described?.node?.backendNodeId,
    objectId: resolvedNode?.object?.objectId,
    label: parsed.label,
    ref: "focused",
    x: parsed.x,
    y: parsed.y,
    selector: parsed.selector,
  };
}

export async function weaveType(
  session: CDP.Client,
  args: {
    id?: string;
    label?: string;
    intent?: string;
    backendNodeId?: number;
    x?: number;
    y?: number;
    text: string;
    clearFirst?: boolean;
    paste?: boolean;
    /** Typing profile: 'normal' (default) | 'fast' | 'deliberate'. Auto-selected if omitted. */
    profile?: "fast" | "normal" | "deliberate";
    /** Set true to include the full updated page_map in the response. Default false. */
    include_map?: boolean;
    fast?: boolean;
    noRetry?: boolean;
  },
  config: Config
): Promise<TypeResult | WeaveError> {
  const { id, label, intent, backendNodeId: directNodeId, text, clearFirst, fast = false } = args;
  const { Page, DOM } = session;

  const startMs = Date.now();

  const { frameTree } = await Page.getFrameTree();
  const url = frameTree.frame.url;

  if (!id && !label && !intent && args.x === undefined && args.y === undefined) {
    return { success: false, error_code: "NO_TARGET", message: `[!] browser_type requires id, label, or intent — no target specified.` };
  }

  const domainCheck = checkDomain(url, config);
  if (!domainCheck.allowed) {
    return { success: false, error_code: "DOMAIN_BLOCKED", message: `[!] Weave blocked: ${domainCheck.reason}` };
  }
  
  // Check for stuck loop before processing
  const stuckCheck = detectStuckLoop();
  if (stuckCheck.stuck) {
    return {
      success: false,
      error_code: "STUCK_LOOP",
      message: stuckCheck.diagnosis || "Agent is stuck in a loop",
      suggestion: "Try a different approach or reset the loop counter",
    };
  }

  let targetId = "default";
  const active = sessionRegistry.getActive(getConfigAgentId(config));
  if (active) targetId = active.targetId;

  const urlObj = new URL(url);
  const hostname = urlObj.hostname;
  const pathname = urlObj.pathname;

  let usedMemoryIntent = false;
  let sniperWarning = "";

  // FAST PATH: Memory Intent Intercept
  // Runs when intent is provided (with or without label — intent takes priority).
  // Soft-miss: if no high-confidence hit, fall through to normal DOM resolution.
  if (intent && !id) {
    const memHit = await getBestSelectorForIntent(hostname, intent, pathname);
    if (memHit) {
      args.id = memHit.selector;
      usedMemoryIntent = true;
      sniperWarning = `(Memory Intercept: Skipped DOM evaluation for intent: '${intent}')`;
      logDebug(`[Memory] Hit! Typing into learned selector '${memHit.selector}' for intent '${intent}'`);
    } else {
      logDebug(`[Memory] Miss for intent '${intent}'. Falling through to DOM resolution.`);
      // Do NOT return an error — fall through to normal resolution below
    }
  }

  // ── 1. Resolve element (fresh map + editable fallbacks) ───────────────────
  // On a memory hit we already have an exact selector — skip the full DOM map build
  // (that's the expensive part on heavy pages, 1–2s). Go straight to coord resolution.
  let map: Awaited<ReturnType<typeof buildActionMap>> | null = null;
  let target: ResolvedTarget | null | undefined;

  if (usedMemoryIntent && args.id) {
    // Memory fast-path: build a minimal synthetic target directly from the selector.
    // No buildActionMap, no resolveTypingTarget, no snapshot delta overhead.
    const syntheticSelector = args.id;
    target = {
      label: intent ?? syntheticSelector,
      ref: "memory",
      selector: syntheticSelector,
      x: undefined,
      y: undefined,
    } as ResolvedTarget;
  } else {
    map = getCachedActionMap(targetId, url);
    if (!map) {
      map = await buildActionMap(session, { lite: true }, targetId);
      cacheActionMap(targetId, map);
    }
    storeSnapshot(targetId, map.url, map.elements);

    // When not memory-resolved: if intent was provided alongside label, label takes fallback slot.
    const query = args.id ?? label ?? intent;
    target = await resolveTypingTarget(session, map, args, targetId);

    if (!target && args.x !== undefined && args.y !== undefined) {
      target = {
        label: `coords(${args.x},${args.y})`,
        ref: `coords`,
        x: args.x,
        y: args.y,
      };
    }

    if (query && !target) {
      const matches = findAllMatches(map.elements, query ?? "");
      if (matches.length > 1) {
        const skipped = matches.slice(1, 4).map(m => `[${m.id}]`).join(", ") + (matches.length > 4 ? ` (+${matches.length - 4} more)` : "");
        return { success: false, error_code: "AMBIGUOUS_TARGET", message: `[!] Refusing to type into ambiguous target. Found ${matches.length} matches for '${query}'. Matches: ${skipped}` };
      }
    } else if (query && target) {
      const matches = findAllMatches(map.elements, query ?? "");
      if (matches.length > 1) {
        const skipped = matches.slice(1, 4).map(m => `[${m.id}]`).join(", ") + (matches.length > 4 ? ` (+${matches.length - 4} more)` : "");
        return { success: false, error_code: "AMBIGUOUS_TARGET", message: `[!] Refusing to type into ambiguous target. Found ${matches.length} matches for '${query}'. Please be more specific or use exact ID. Matches: ${skipped}` };
      }
    }
  }

  if (target && target.selector) {
    const isEditableRes = await session.Runtime.evaluate({
      expression: `(function(sel) {
        const el = document.querySelector(sel);
        if (!el) return true; // optimistic: let it try
        const tag = el.tagName.toLowerCase();
        const t = (el.getAttribute('type') || '').toLowerCase();
        const role = (el.getAttribute('role') || '').toLowerCase();
        // Standard editable
        if (el.isContentEditable) return true;
        if (tag === 'textarea') return true;
        if (tag === 'input' && !['button','submit','checkbox','radio','hidden','file','image','reset'].includes(t)) return true;
        // ARIA editable roles — many custom widgets use these
        if (role === 'textbox' || role === 'combobox' || role === 'searchbox' || role === 'spinbutton') return true;
        // Custom div/span inputs often have no role — check for contenteditable ancestors
        if (el.closest('[contenteditable]')) return true;
        return false;
      })(${JSON.stringify(target.selector)})`,
      returnByValue: true
    }).catch(() => null);

    // Soft fail: warn but don't hard-block. Some custom widgets look non-editable but still accept input.
    if (isEditableRes && isEditableRes.result?.value === false) {
      // Return a graceful error with actionable fallback instructions
      return {
        success: false,
        error_code: "NOT_EDITABLE",
        message: `[!] Element (${target.selector}) does not appear to be a standard editable field. Fallback: (1) use browser_click on the field to focus it, then (2) use browser_key to send individual characters or (3) use browser_eval to set the value directly via JS.`,
        suggestion: `browser_click { id: "${target.ref}" } then browser_key { key: "<yourtext>" }`,
      } as any;
    }
  }

  if (!target) {
    if (intent && args.id) {
      await logMemoryFailure(hostname, intent, args.id, "DEAD_SELECTOR", pathname);
    }
    return { success: false, error_code: "ELEMENT_NOT_FOUND", message: `[!] Could not find input matching "${id ?? label ?? intent ?? "any field"}"` };
  }

  const loopDiag = getLoopDiagnostics("browser_type", target.ref);
  if (loopDiag.severity === "critical") {
    return { success: false, error_code: "STUCK_LOOP_WARNING", message: `[!] Loop detected: You have tried to type into [${target.ref}] ${loopDiag.strikes} times without success. Call browser_reset_loop_counter if this is a new task.` };
  }
  if (loopDiag.severity === "warning") {
    logAction("browser_type", target.ref, `loop warning: ${loopDiag.strikes} consecutive strikes on [${target.ref}]`);
  }

  // Get stable selector for coordinate resolution
  const selector = target.selector || (target.ref === "focused" ? "document.activeElement" : `[data-wt-id="${(target.ref ?? '').split(':')[1] ?? target.ref ?? ''}"]`);

  // 2. Frame Awareness & Coordinate Resolution
  let coords: any = null;
  let frameUrl: string | null = null;
  try {
    const res = await session.Runtime.evaluate({
      expression: `(function(sel) {
        const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
        if (!el) return null;
        return { 
          coords: window.__Weavetab_getCoords(sel), 
          inIframe: el.ownerDocument.defaultView !== window,
          frameUrl: el.ownerDocument.defaultView.location.href
        };
      })(${JSON.stringify(selector)})`,
      returnByValue: true
    });
    coords = res.result?.value?.coords;
    frameUrl = res.result?.value?.frameUrl;
  } catch (e) {
    logDebug(`Failed to resolve typing target ${selector}:`, e);
  }

  if (!coords) {
    if (target.x !== undefined && target.y !== undefined) {
      coords = { x: target.x, y: target.y };
    } else if (args.x !== undefined && args.y !== undefined) {
      coords = { x: args.x, y: args.y };
    } else {
      return { success: false, error_code: "COORD_RESOLUTION_FAILED", message: `[!] Extension could not resolve coordinates for input ${selector} and no fallback coordinates available` };
    }
  }

  let resolvedLabel = target.label || "";
  const resolvedRef = target.ref;

  // ── Playwright-strategy pre-focus actionability gate ─────────────────────────
  // Verify the target is stable, unoccluded, and in viewport before any
  // mouse events are fired. Uses 4-way scroll + RAF stability + WT transparency.
  if (selector && selector !== 'document.activeElement') {
    const actCheck = await verifyActionability(session, selector, {
      stabilityTimeoutMs: 300,
      totalTimeoutMs: 1800,
    });
    if (actCheck.status === 'OCCLUDED' && !actCheck.occludedBy?.isWeavetabOwned) {
      const occ = actCheck.occludedBy!;
      const id = occ.id ? `#${occ.id}` : '';
      const cls = occ.className ? `.${occ.className.split(' ')[0]}` : '';
      return {
        success: false,
        error_code: "ELEMENT_OCCLUDED_BY",
        message: `[!] <${occ.tag}${id}${cls}${occ.ariaLabel ? ` "${occ.ariaLabel}"` : ''}> intercepts pointer events — cannot type into ${selector}. Handle the blocking element first.`,
      } as WeaveError;
    } else if (actCheck.status === 'INVISIBLE') {
      return {
        success: false,
        error_code: "ELEMENT_INVISIBLE",
        message: `[!] Target field ${selector} is not visible. Use browser_scroll or browser_click to reveal it first.`,
      } as WeaveError;
    } else if (actCheck.status === 'NOT_FOUND') {
      // Non-fatal for type — the element might be in shadow DOM; continue with coord path
      logDebug(`[browser_type] verifyActionability: NOT_FOUND for ${selector}, proceeding with raw coords`);
    } else if (actCheck.status === 'ACTIONABLE' && actCheck.x !== undefined) {
      // Use the verified stable coords from the actionability engine
      coords = { x: actCheck.x, y: actCheck.y };
    }
  }

  const typePreview = text.slice(0, 20).replace(/'/g, "");
  const typeStatus = ["typing", "entering", "inputting", "writing"][Math.floor(Math.random() * 4)];
  await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: `${typeStatus} ${typePreview}...` } });

  // ── 3. Focus + Type ──────────────────────────────────────────────────────
  if (coords.x !== undefined && coords.y !== undefined) {
    const ghostMoveProfile = args.profile === "fast" ? "fast" : "human";
    await ghostMove(session, coords.x, coords.y, config, resolvedLabel.slice(0, 30), ghostMoveProfile);
    await sendToExtension(session, { type: 'Weavetab_STATE', cursor: { x: coords.x, y: coords.y }, state: 'typing' });
    if (!getConfigHeadless(config)) await new Promise(r => setTimeout(r, 100 + Math.random() * 150));
  }

  // Focus + optional clear via focusEditable when we have an objectId
  // Phase 3b: clearFirst only runs when explicitly true — insertText replaces content naturally
  if (target.objectId) {
    await focusEditable(session, target.objectId, clearFirst === true, fast);
    await new Promise(r => setTimeout(r, fast ? 10 : 80 + Math.random() * 80));
  } else {
    // Fallback: click-to-focus via CDP dispatchMouseEvent (Phase 3a)
    // ── Pre-focus hit-target check (mirrors Playwright Step 6) ────────────
    // The misclick-onto-overlay issue happens because ghostClick fires at coords
    // without checking what is actually on top. Run quickHitCheck here so we
    // abort before touching the field.
    if (coords.x !== undefined && coords.y !== undefined && selector && selector !== 'document.activeElement') {
      const hitCheck = await quickHitCheck(session, coords.x, coords.y, selector);
      if (!hitCheck.clear) {
        return {
          success: false,
          error_code: "ELEMENT_OCCLUDED_BY",
          message: `[!] ${hitCheck.blockerDescription ?? 'An overlay intercepts pointer events'} — cannot focus ${selector}. Dismiss the overlay first, then retry browser_type.`,
        } as WeaveError;
      }
    }
    
    if (coords.x !== undefined && coords.y !== undefined) {
      await ghostClick(session, coords.x, coords.y);
      await session.Input.dispatchMouseEvent({ type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
      await new Promise(r => setTimeout(r, fast ? 10 : 100 + Math.random() * 100));
    }

    // Manual clear only when explicitly requested (insertText replaces naturally)
    const shouldPaste = args.paste || text.length > 8;
    if (clearFirst === true && !shouldPaste) {
      await session.Runtime.evaluate({
        expression: `(function(sel) {
          const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
          if (!el) return;
          if (el.isContentEditable) { 
            el.textContent = ''; 
          } else { 
            el.value = ''; 
            const nativeSetter = el.tagName === 'TEXTAREA'
              ? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
              : Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) nativeSetter.call(el, '');
          }
          el.dispatchEvent(new Event('input',{bubbles:true}));
          el.dispatchEvent(new Event('change',{bubbles:true}));
        })(${JSON.stringify(selector)})`,
        returnByValue: false,
      }).catch(() => {});
      await new Promise(r => setTimeout(r, 40));
    }
  }

  // Verify focus landed correctly
  const focusCheck = await session.Runtime.evaluate({
    expression: `(function(sel) {
      const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
      return document.activeElement === el || (el ? el.contains(document.activeElement) : false);
    })(${JSON.stringify(selector)})`,
    returnByValue: true
  }).catch(() => null);

  if (focusCheck?.result?.value === false) {
    console.warn(`[Weavetab] Focus didn't land on ${selector}, re-clicking...`);
    if (coords.x !== undefined && coords.y !== undefined) {
      await ghostClick(session, coords.x, coords.y);
      await session.Input.dispatchMouseEvent({ type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
      await new Promise(r => setTimeout(r, 60));
    }
  }

  // ── Phase 3b: Framework-aware typing method ───────────────────────────────
  // Detect framework to choose optimal input strategy
  const framework = await detectFramework(session);

  // Tracks whether frameworkAwareType's native-setter path was used.
  // When true the post-type event dispatch block is suppressed to prevent
  // the double-onChange triplication bug on React/Vue controlled inputs.
  let nativeSetterUsed = false;
  
  // Detect password fields — always ghost type these regardless of profile
  const isPassword = await session.Runtime.evaluate({
    expression: `(function(sel) {
      const el = document.querySelector(sel);
      return el ? (el.getAttribute('type') || '').toLowerCase() === 'password' : false;
    })(${JSON.stringify(selector)})`,
    returnByValue: true
  }).then(r => r.result?.value === true).catch(() => false);

  // Click-to-type delay
  await new Promise(r => setTimeout(r, 50 + Math.random() * 100));

  // Auto-enable paste mode for long inputs to prevent character dropping
  const shouldPasteForType = args.paste || text.length > 8;

  if (shouldPasteForType && !isPassword) {
    // Paste mode: Use clipboard for reliable long input handling
    // This prevents character dropping on long inputs
    let clipboardOk = false;
    try {
      const { browserClipboard } = await import("./clipboard.js");
      // skipActivation=true: field is already focused; the (5,5) activation click
      // in browserClipboard would blur the input before Ctrl+V.
      await browserClipboard(session, { action: "write", text, skipActivation: true }, config);
      clipboardOk = true;
    } catch (clipErr) {
      logDebug(`[browser_type] Clipboard write failed (${clipErr}), falling back to insertText`);
    }
    if (clipboardOk) {
      await new Promise(r => setTimeout(r, 50));
      // Paste via Ctrl+V
      await session.Input.dispatchKeyEvent({ type: "rawKeyDown", key: "v", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2 });
      await session.Input.dispatchKeyEvent({ type: "keyUp", key: "v", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2 });
      await new Promise(r => setTimeout(r, 120));

      // Paste verification: check if the field actually received the text.
      // Vue/React controlled inputs re-render the DOM node during focus, making
      // Ctrl+V land on the old (detached) node. If el.value is still empty,
      // fallback to Input.insertText which targets the currently-focused element.
      if (selector) {
        const pasteCheck = await session.Runtime.evaluate({
          expression: `(function(sel) {
            var el = (sel === 'document.activeElement') ? document.activeElement : (document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null));
            if (!el) return null;
            return el.value !== undefined ? el.value : (el.textContent || null);
          })(${JSON.stringify(selector)})`,
          returnByValue: true,
        }).catch(() => null);
        const pastedVal = pasteCheck?.result?.value as string | null;
        if (!pastedVal || pastedVal.trim() === '') {
          logDebug(`[browser_type] Paste landed empty on ${selector} — retrying with Input.insertText`);
          await session.Input.insertText({ text });
        }
      }
    } else {
      // Clipboard unavailable — fall back to direct engine-level text insertion
      await session.Input.insertText({ text });
    }
  } else if (isPassword || (args.profile === 'deliberate' && !shouldPasteForType)) {
    // Security/anti-bot: ghostType — per-character timing with human jitter
    await ghostType(session, text, config, selector, isPassword ? 'fast' : 'deliberate');
  } else if (framework === 'react' || framework === 'vue') {
    // Framework-aware: native-setter path for React/Vue controlled inputs.
    // frameworkAwareType returns true when the native-setter + InputEvent path
    // was taken. In that case we MUST NOT fire an additional Event('input') below
    // — doing so causes a second onChange dispatch and duplicates/triplicates text.
    if (target.objectId) {
      nativeSetterUsed = await frameworkAwareType(session, target.objectId, text, framework);
    } else {
      // Selector-based fallback — same native-setter logic, single InputEvent only
      await session.Runtime.evaluate({
        expression: `(function(sel, txt) {
          const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
          if (!el) return;

          const nativeInputSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set;
          const nativeTextAreaSetter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          )?.set;

          if (el.tagName === 'INPUT' && nativeInputSetter) {
            nativeInputSetter.call(el, txt);
          } else if (el.tagName === 'TEXTAREA' && nativeTextAreaSetter) {
            nativeTextAreaSetter.call(el, txt);
          } else if (el.isContentEditable) {
            el.textContent = txt;
          } else {
            el.value = txt;
          }

          // Single InputEvent — React 16/17/18 SyntheticEvent source.
          // Do NOT also dispatch plain Event('input') — that fires onChange twice.
          el.dispatchEvent(new InputEvent('input', {
            bubbles: true, cancelable: true, inputType: 'insertText', data: txt
          }));
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        })(${JSON.stringify(selector)}, ${JSON.stringify(text)})`,
        returnByValue: false,
        awaitPromise: true,
      });
      nativeSetterUsed = true;
    }
  } else {
    // PRIMARY: Input.insertText — engine-level text insertion for vanilla JS/Angular
    await session.Input.insertText({ text });
  }

  await sendToExtension(session, { type: 'Weavetab_STATE', hud: { action: '' } });

  // Post-type event dispatch: only needed for vanilla/Angular paths.
  // React/Vue native-setter path already dispatched InputEvent + change above.
  // Firing again here would trigger a second onChange and duplicate the value.
  if (!nativeSetterUsed) {
    await session.Runtime.evaluate({
      expression: `(function(sel) {
        const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
        if (!el) return;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })(${JSON.stringify(selector)})`,
      returnByValue: false,
    }).catch(() => {});
  }

  const executionMs = Date.now() - startMs;

  // ── 4. Post-Action Pipeline — settle + delta ──────────────────────────────
  await Promise.all([
    waitForDOMStable(session, 50, 400),
    waitForNetworkIdle(session, 50, 300).catch(() => { }),
  ]);

  let nextMap = getCachedActionMap(targetId, url);
  if (!nextMap) {
    nextMap = await buildActionMap(session, { lite: true }, targetId);
    cacheActionMap(targetId, nextMap);
  }

  let postUrl = url;
  let postTitle = "";
  try {
    const { frameTree: postFrame } = await Page.getFrameTree();
    postUrl = postFrame.frame.url;
    try {
      const titleRes = await session.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
      postTitle = (titleRes?.result?.value as string) || postUrl;
    } catch { postTitle = postUrl; }
    const activeSession = sessionRegistry.getActive(getConfigAgentId(config));
    if (activeSession) { activeSession.url = postUrl; activeSession.title = postTitle; }
  } catch { /* ignore */ }

  // Targeted field verification — always runs, independent of computeDelta.
  // This catches cases where a framework (React/Vue) overrides the value after render.
  let textApplied = false;
  if (text) {
    try {
      const isActiveElementRef = selector === "document.activeElement";
      const getFieldValue = async (): Promise<string | null> => {
        const expression = isActiveElementRef
          ? `(function() {
              var el = document.activeElement;
              if (!el) return null;
              return el.value !== undefined ? el.value : (el.textContent || null);
            })()`
          : `(function(sel) {
              var el = document.querySelector(sel);
              if (!el) return null;
              return el.value !== undefined ? el.value : (el.textContent || null);
            })(${JSON.stringify(selector)})`;
        const { result } = await session.Runtime.evaluate({ expression, returnByValue: true });
        return result?.value as string | null;
      };

      const val = await getFieldValue();
      textApplied = val === text || (typeof val === 'string' && val.trim() === text.trim())
                    // tel/formatted inputs may strip chars (e.g. dashes); also
                    // accept if the value simply contains the digits we typed.
                    || (typeof val === 'string' && typeof text === 'string' &&
                        val.replace(/\D/g, '') === text.replace(/\D/g, '') && text.length > 3);

      if (!textApplied) {
        await new Promise(r => setTimeout(r, 200));
        await waitForDOMStable(session, 50, 200).catch(() => {});
        const retryVal = await getFieldValue();
        textApplied = retryVal === text || (typeof retryVal === 'string' && retryVal.trim() === text.trim());
      }

      if (!textApplied) {
        await new Promise(r => setTimeout(r, 400));
        await waitForDOMStable(session, 50, 300).catch(() => {});
        const finalVal = await getFieldValue();
        textApplied = finalVal === text || (typeof finalVal === 'string' && finalVal.trim() === text.trim());
      }

      // ghostType may drop characters on busy Windows machines.
      // Retry with atomic Input.insertText if ghostType failed verification.
      if (!textApplied && !args.noRetry && (isPassword || args.profile === 'deliberate')) {
        await session.Input.insertText({ text });
        await new Promise(r => setTimeout(r, 300));
        const retryVal = await getFieldValue();
        textApplied = retryVal === text || (typeof retryVal === 'string' && retryVal.trim() === text.trim());
      }

      // Paste mode failed — retry with Input.insertText (already focused, so this lands correctly).
      if (!textApplied && !args.noRetry && shouldPasteForType && !isPassword) {
        await session.Input.insertText({ text });
        await new Promise(r => setTimeout(r, 200));
        const pasteRetryVal = await getFieldValue();
        textApplied = pasteRetryVal === text || (typeof pasteRetryVal === 'string' && pasteRetryVal.trim() === text.trim());
      }
    } catch { /* non-fatal */ }
  }

  // ─── SPA InputEvent retry (Q2: conditional auto, driven by sessionMemory) ────────────────
  // If the text wasn't confirmed AND we know this is a React/Vue/Angular site
  // (or a prior hint tells us), auto-retry with nativeInputValueSetter strategy.
  // No extra CDP calls when textApplied is true (common case).
  let spaRetryApplied = false;
  let spaRetryStrategy = '';
  if (!textApplied && !args.noRetry && selector && selector !== 'document.activeElement') {
    // Load domain profile for framework detection (already in memory, no I/O)
    const domProfile = await loadDomainProfile(hostname).catch(() => null);
    const profileFramework = domProfile?.framework as string | undefined;
    // Inline framework probe — single evaluate, zero extra round-trips beyond sessionMemory miss
    let detectedFramework = profileFramework;
    if (!detectedFramework) {
      const fwCheck = await session.Runtime.evaluate({
        expression: `(function(){
          var r=document.documentElement;
          if(r.__reactFiber||r._reactRootContainer) return 'react';
          if(r.__vue__||document.querySelector('[data-v-]')) return 'vue';
          if(r.ng||document.querySelector('[ng-version]')) return 'angular';
          return '';
        })()`,
        returnByValue: true,
      }).catch(() => null);
      detectedFramework = (fwCheck?.result?.value as string) || '';
    }
    const hasSpaHint = domProfile?.memories?.some(
      (m: any) => m.note?.includes('react_input_required') ||
                  m.hint?.includes('react_input_required')
    ) ?? false;
    const isSpa = ['react', 'vue', 'angular', 'next', 'nuxt', 'gatsby'].includes(detectedFramework) || hasSpaHint;

    if (isSpa) {
      const { omniEvaluate } = await import("../cdp/omni_broker.js");
      // Single Runtime.evaluate — nativeInputValueSetter + InputEvent dispatch
      const rawRes = await omniEvaluate(session, targetId, `(function(sel, value) {
          try {
            var el = document.querySelector(sel) ||
                     (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
            if (!el) return JSON.stringify({ ok: false, strategy: 'NOT_FOUND', exists: false });

            // Strategy A: React's internal nativeInputValueSetter override
            var nativeSetter =
              Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set ||
              Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

            if (nativeSetter) {
              nativeSetter.call(el, value);
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new InputEvent('input', {
                bubbles: true, data: value, inputType: 'insertText'
              }));
              return JSON.stringify({ ok: el.value === value, strategy: 'native-setter', value: el.value, exists: true });
            }

            // Strategy B: contenteditable with InputEvent
            if (el.isContentEditable) {
              el.textContent = value;
              el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
              return JSON.stringify({ ok: el.textContent === value, strategy: 'contenteditable', value: el.textContent, exists: true });
            }

            // Strategy C: direct value + dispatchEvent fallback
            el.value = value;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return JSON.stringify({ ok: el.value === value, strategy: 'direct-event', value: el.value, exists: true });
          } catch(e) {
            return JSON.stringify({ ok: false, strategy: 'ERROR', error: e.message, exists: false });
          }
        })(${JSON.stringify(selector)}, ${JSON.stringify(text)})`);

      if (rawRes) {
        try {
          const spaRes = typeof rawRes === 'string' ? JSON.parse(rawRes) : rawRes;
          if (spaRes.ok) {
            textApplied = true;
            spaRetryApplied = true;
            spaRetryStrategy = spaRes.strategy;
          }
        } catch { /* non-fatal */ }
      }
    } else if (!isSpa) {
      // Framework unknown and confirmed:false — write a generic hint so next call knows
      await appendKnowledgeHint(
        hostname,
        'input_not_confirmed: browser_type confirmed:false on this domain — typing succeeded but value could not be verified, consider browser_fill for guaranteed fill'
      ).catch(() => {});
    }
  }
  // ───────────────────────────────────────────────────────────────────────────

  const diff = await computeRichDelta(targetId, postUrl, nextMap.elements);
  const changesCount = diff && !("delta_timeout" in diff) ? diff.added.length + diff.removed.length + diff.changed.length : 0;
  let isStuck = !textApplied && changesCount === 0 && postUrl === url;


  // page_map is expensive on heavy pages. Only compute when explicitly requested
  // or when the URL changed (agent needs the new page's element list).
  const includeMap = args.include_map || postUrl !== url;
  const pageMap = includeMap ? toMarkdownTable(nextMap.elements, postUrl, postTitle) : undefined;
  const domChanged = !isStuck || postUrl !== url;

  // Record typing strategy and known input in domain profile for future sessions
  try {
    const actionUrlObj = new URL(postUrl);
    const actionHostname = actionUrlObj.hostname;
    const actionPathname = actionUrlObj.pathname;

    if (intent && (args.id || selector)) {
      const finalSelector = args.id || selector;
      if (isStuck) {
        await logMemoryFailure(actionHostname, intent, finalSelector, "ACTION_FAILED", actionPathname);
      } else {
        await logMemorySuccess(actionHostname, intent, finalSelector, { 
          role: 'textbox',
          structuralIdiom: target.structuralIdiom
        }, actionPathname);
      }
    } else {
      const knownInputs = resolvedLabel && resolvedLabel !== "focused" && resolvedLabel !== ""
        ? [{ label: resolvedLabel, selector: selector }]
        : undefined;
      await saveDomainProfile(actionHostname, {
        strategies: ["insertText"],
        ...(knownInputs ? { knownInputs } : {}),
      }).catch(() => {});
    }
  } catch { /* best-effort */ }

  logAction("browser_type", resolvedRef, `[text] into ${resolvedLabel} (exec: ${executionMs}ms)`);
  recordAction({
    timestamp: new Date().toISOString(),
    tool: "browser_type",
    input: { ref: resolvedRef, label: resolvedLabel, text: "[REDACTED]" },
    result: { success: true, stuck: isStuck },
  });
  
  // Track tool call for loop detection
  trackToolCall("browser_type", resolvedRef, { 
    success: !isStuck, 
    domChanged: domChanged 
  });
  
  // Capture element state after typing
  let elementState: Record<string, unknown> | undefined;
  if (selector) {
    try {
      const { result: stateResult } = await session.Runtime.evaluate({
        expression: `(function(sel) {
          var el = document.querySelector(sel);
          if (!el) return null;
          var isSecret = el.hasAttribute('data-wt-secret') || (el.tagName === 'INPUT' && el.type === 'password');
          return {
            tag: el.tagName.toLowerCase(),
            visible: el.offsetParent !== null,
            disabled: el.disabled,
            value: isSecret ? '[REDACTED]' : el.value,
            label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('name') || (el.textContent||'').trim().slice(0,40),
            textContent: isSecret ? '[REDACTED]' : (el.isContentEditable ? el.textContent?.slice(0, 100) : undefined)
          };
        })(${JSON.stringify(selector)})`,
        returnByValue: true,
      });
      if (stateResult?.value) {
        elementState = stateResult.value;
        if (elementState && elementState.label && typeof elementState.label === 'string') {
          resolvedLabel = elementState.label;
        }
      }
    } catch { /* ignore */ }
  }
  
  // Suggest next action based on what happened
  let suggestedNext: string | undefined;
  if (isStuck) {
    suggestedNext = "Typing had no visible effect - try browser_fill for React/Vue controlled inputs or check validation";
  } else if (domChanged) {
    suggestedNext = "Typing successful and page responded - check for validation messages or proceed to next field";
  } else {
    suggestedNext = "Typing successful - consider clicking submit or proceeding to next field";
  }

  // Read back the verified field value to report accurate length.
  // Previously this was always text.length, which was misleading when paste failed silently.
  let verifiedLength = text.length;
  if (selector && selector !== 'document.activeElement') {
    try {
      const { result: vlRes } = await session.Runtime.evaluate({
        expression: `(function(sel) {
          var el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
          if (!el) return -1;
          var v = el.value !== undefined ? el.value : (el.textContent || '');
          return (v || '').length;
        })(${JSON.stringify(selector)})`,
        returnByValue: true,
      });
      if (typeof vlRes?.value === 'number' && vlRes.value >= 0) {
        verifiedLength = vlRes.value;
      }
    } catch { /* non-fatal */ }
  }

  return {
    success: true,
    typed_into: resolvedLabel,
    ref: resolvedRef,
    length: verifiedLength,
    execution_ms: executionMs,
    tab_id: targetId,
    url: postUrl,
    title: postTitle,
    page_map: pageMap,
    dom_changed: domChanged,
    stuck_warning: isStuck,
    stuck_hint: isStuck
      ? (verifiedLength === 0 && text.length > 0
          ? `Field value is still empty after typing — the DOM read-back confirmed nothing was written (length: 0). ` +
            `This is a controlled input (React/Vue/Angular) that ignores synthetic keyboard events. ` +
            `Try browser_fill which uses nativeInputValueSetter to bypass framework input guards.`
          : `Page did not visibly respond to the typed text (DOM unchanged, URL unchanged). ` +
            `If the input is controlled by React/Vue, try browser_fill instead.`)
      : undefined,
    sniper_warning: sniperWarning || undefined,
    memory_hit: usedMemoryIntent,
    delta: diff ?? undefined,
    // SEMANTIC RESPONSE CONTRACT
    confirmed: !isStuck,
    strategy: usedMemoryIntent ? "memory_intent"
      : spaRetryApplied ? `spa-retry:${spaRetryStrategy}`
      : target.x !== undefined ? "coordinates" : "direct",
    elementState,
    suggestedNext
  };
}
