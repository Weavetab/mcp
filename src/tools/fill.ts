import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { getConfigAgentId } from "../config/loader.js";
import { logAction, logDebug } from "../audit/logger.js";
import { recordAction, detectStuckLoop, detectCrossToolLoop, trackToolCall } from "../intelligence/trail.js";
import { sendToExtension } from "../cdp/helpers.js";
import { confirmChange } from "../cdp/confirm.js";
import { verifyActionability } from "../sensors/actionability.js";

export interface FillField {
  ref: string;
  value: string;
}

/** A single cell write for Google Sheets / Canvas grid filling. */
export interface GridCell {
  /** Cell address in A1 notation, e.g. "A1", "B3", "C12". */
  cell: string;
  /** Value to type into the cell. */
  value: string;
}

export interface FillOptions {
  fields?: FillField[];
  submit?: string;
  scan_only?: boolean;
  blast_mode?: boolean;
  /** Grid-fill mode for Google Sheets and other canvas-rendered spreadsheets.
   *  Provide cell addresses in A1 notation with their values.
   *  The tool uses the Chrome Accessibility Tree to locate each cell. */
  grid_data?: GridCell[];
}

export interface FillResult {
  success: boolean;
  total_fields: number;
  succeeded: number;
  failed: number;
  submitted: boolean;
  results: {
    ref: string;
    field_type: string;
    success: boolean;
    message: string;
    value?: string;
  }[];
  execution_ms: number;
  /** Concrete next step for the agent when fill fails */
  suggestedNext?: string;
}


function toSelector(ref: string): string {
  const refId = ref.startsWith("w:") ? ref.split(":")[1] : null;
  return refId ? `[data-wt-id="${refId}"]` : ref;
}

function esc(s: string): string {
  return JSON.stringify(s);
}

/**
 * Detect the field type of an element WITHOUT mutating it.
 * Runs in a single CDP call — returns { type, exists, fillable }.
 */
async function detectFieldType(session: CDP.Client, selector: string): Promise<{ type: string; exists: boolean; fillable: boolean; isSecret: boolean }> {
  const { result } = await session.Runtime.evaluate({
    expression: `(function() {
      var el = document.querySelector(${esc(selector)});
      if (!el) return JSON.stringify({ exists: false, fillable: false });
      if (el.tagName === 'LABEL') {
        var forId = el.getAttribute('for');
        var target = forId ? document.getElementById(forId) : el.querySelector('input, textarea, select');
        if (target) el = target;
      } else if (!['input', 'select', 'textarea'].includes(el.tagName.toLowerCase()) && !el.isContentEditable) {
        var inner = el.querySelector('input, textarea, select');
        if (inner) el = inner;
      }
      var tag = el.tagName.toLowerCase();
      var t = (el.getAttribute('type') || 'text').toLowerCase();
      var role = (el.getAttribute('role') || '').toLowerCase();
      var isCE = el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '';
      var isCombobox = role === 'combobox' || role === 'textbox';
      var type;
      if (tag === 'select') type = 'select';
      else if (tag === 'input' && t === 'checkbox') type = 'checkbox';
      else if (tag === 'input' && t === 'radio') type = 'radio';
      else if (role === 'checkbox') type = 'custom-checkbox';
      else if (role === 'radio') type = 'custom-radio';
      else if (role === 'switch') type = 'custom-checkbox';
      else if (role === 'listbox' || role === 'option') type = 'select';
      else if (tag === 'textarea' || (tag === 'input' && ['text','email','tel','url','password','search','number','time','date','datetime-local','month','week'].includes(t)) || isCE || isCombobox) type = 'text';
      else type = 'unknown';
      // Check fillability — disabled or readonly fields cannot be written to.
      var ariaDisabled = el.getAttribute('aria-disabled');
      var fillable = !el.disabled && !el.readOnly && ariaDisabled !== 'true' && ariaDisabled !== '';
      // For checkboxes/radios, readOnly doesn't apply — but disabled does.
      if (type === 'checkbox' || type === 'radio' || type === 'custom-checkbox' || type === 'custom-radio') {
        fillable = !el.disabled && ariaDisabled !== 'true';
      }
      var isSecret = el.hasAttribute('data-wt-secret') || (el.tagName === 'INPUT' && el.type === 'password');
      return JSON.stringify({ exists: true, type: type, fillable: fillable, isSecret: isSecret });
    })()`,
    returnByValue: true,
  });
  return JSON.parse((result?.value as string) || '{"exists":false,"type":"unknown","fillable":false,"isSecret":false}');
}

/**
 * Snapshot the current state of a field for before/after comparison.
 * Captures whatever property matters for that field type.
 */
async function getFieldState(session: CDP.Client, selector: string, type: string): Promise<Record<string, string>> {
  const { result } = await session.Runtime.evaluate({
    expression: `(function(type) {
      var el = document.querySelector(${esc(selector)});
      if (!el) return JSON.stringify({ exists: "false" });
      if (el.tagName === 'LABEL') {
        var forId = el.getAttribute('for');
        var target = forId ? document.getElementById(forId) : el.querySelector('input, textarea, select');
        if (target) el = target;
      } else if (!['input', 'select', 'textarea'].includes(el.tagName.toLowerCase()) && !el.isContentEditable) {
        var inner = el.querySelector('input, textarea, select');
        if (inner) el = inner;
      }
      var s = { exists: "true" };
      if (el.tagName === 'SELECT') {
        var idx = el.selectedIndex;
        s.selectedIndex = String(idx);
        s.value = el.value;
        s.text = idx >= 0 ? el.options[idx].text : "";
      } else if (el.type === 'checkbox' || el.type === 'radio' || type === 'custom-checkbox' || type === 'custom-radio') {
        // Native checkbox/radio uses .checked; ARIA elements use aria-checked
        var ariaChecked = el.getAttribute('aria-checked');
        var isChecked = el.checked !== undefined ? el.checked : (ariaChecked === 'true' || ariaChecked === 'mixed');
        s.checked = isChecked ? "true" : "false";
        if (ariaChecked !== null) s.ariaChecked = ariaChecked;
      } else if (el.isContentEditable) {
        s.text = el.textContent || "";
      } else {
        s.value = el.value;
      }
      return JSON.stringify(s);
    })(${esc(type)})`,
    returnByValue: true,
  });
  return JSON.parse((result?.value as string) || '{"exists":"false"}');
}

/**
 * Apply a value to a field. Returns { ok, msg }. Mutates the DOM.
 * Native prototype setters + event dispatch keep React/Vue state in sync.
 */
async function applyFieldValue(
  session: CDP.Client,
  selector: string,
  value: string,
  type: string
): Promise<{ ok: boolean; msg: string }> {
  const { result } = await session.Runtime.evaluate({
    expression: `(function(selector, value, type) {
      try {
        var el = document.querySelector(selector);
        if (!el) return JSON.stringify({ ok: false, msg: 'Element not found' });
        if (el.tagName === 'LABEL') {
          var forId = el.getAttribute('for');
          var target = forId ? document.getElementById(forId) : el.querySelector('input, textarea, select');
          if (target) el = target;
        } else if (!['input', 'select', 'textarea'].includes(el.tagName.toLowerCase()) && !el.isContentEditable) {
          var inner = el.querySelector('input, textarea, select');
          if (inner) el = inner;
        }

        if (type === 'text') {
          el.focus();
          // NOTE: el.click() intentionally removed — it generates bubbling click events
          // that can activate extension UI elements (wt-minimize-btn etc.) when the
          // field is adjacent to the WeaveTab panel. el.focus() is sufficient; the
          // value is written via native setter + synthetic input/change events.
          if (el.isContentEditable) {
            // contenteditable: set via textContent and also try execCommand for rich editors
            el.textContent = value;
            try { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, value); } catch(e2) {}
          } else {
            var tag = el.tagName.toLowerCase();
            var proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            var ns = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (ns) ns.call(el, value); else el.value = value;
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return JSON.stringify({ ok: true, msg: 'filled' });
        }
        if (type === 'checkbox' || type === 'custom-checkbox') {
          var shouldCheck = value === 'true' || value === 'yes' || value === 'checked' || value === '1' || value === 'on';
          var isNative = el.tagName === 'INPUT' && el.type === 'checkbox';
          if (isNative) {
            var currentlyChecked = el.checked;
            if (currentlyChecked !== shouldCheck) {
              // Use native checked setter to bypass React's synthetic event system
              var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
              if (nativeSetter) nativeSetter.call(el, shouldCheck); else el.checked = shouldCheck;
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
              el.dispatchEvent(new Event('input', { bubbles: true }));
            }
          } else {
            // ARIA custom checkbox (role=checkbox/switch): toggle aria-checked and click
            var ariaChecked = el.getAttribute('aria-checked');
            var isCurrentlyChecked = ariaChecked === 'true';
            if (isCurrentlyChecked !== shouldCheck) {
              el.setAttribute('aria-checked', shouldCheck ? 'true' : 'false');
              el.click();
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          return JSON.stringify({ ok: true, msg: shouldCheck ? 'checked' : 'unchecked' });
        }
        if (type === 'radio' || type === 'custom-radio') {
          var isNativeRadio = el.tagName === 'INPUT' && el.type === 'radio';
          if (isNativeRadio) {
            if (!el.checked) {
              var nativeRadioSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
              if (nativeRadioSetter) nativeRadioSetter.call(el, true); else el.checked = true;
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          } else {
            if (el.getAttribute('aria-checked') !== 'true') {
              el.setAttribute('aria-checked', 'true');
              el.click();
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }
          return JSON.stringify({ ok: true, msg: 'selected' });
        }
        if (type === 'select') {
          var foundIdx = -1;
          for (var j = 0; j < el.options.length; j++) {
            var opt = el.options[j];
            if (opt.value === value || opt.text === value || opt.text.trim() === value.trim()) {
              foundIdx = j; break;
            }
          }
          if (foundIdx === -1) return JSON.stringify({ ok: false, msg: 'Option not found: ' + value });
          var nativeSelectSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
          if (nativeSelectSetter) nativeSelectSetter.call(el, el.options[foundIdx].value);
          else el.selectedIndex = foundIdx;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          el.options[foundIdx].dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return JSON.stringify({ ok: true, msg: 'selected:' + el.options[foundIdx].text });
        }
        return JSON.stringify({ ok: false, msg: 'Unsupported field type: ' + type });
      } catch(e) {
        return JSON.stringify({ ok: false, msg: e.message || String(e) });
      }
    })(${esc(selector)}, ${esc(value)}, ${esc(type)})`,
    returnByValue: true,
  });
  return JSON.parse((result?.value as string) || '{"ok":false,"msg":"eval failed"}');
}

// ── Google Sheets grid fill helpers ──────────────────────────────────────

/** Parse A1 notation into { col: number (0-indexed), row: number (0-indexed) }. */
function parseA1(cell: string): { col: number; row: number } | null {
  const m = cell.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
}

/** Find a cell in the AX tree by A1 address. Returns { x, y } center coordinates. */
async function findSheetCellCoords(
  session: CDP.Client,
  cellAddress: string
): Promise<{ x: number; y: number } | null> {
  const parsed = parseA1(cellAddress);
  if (!parsed) return null;

  // Enable accessibility domain
  try { await session.Accessibility.enable(); } catch { /* already enabled */ }

  let nodes: any[] = [];
  try {
    const result = await session.Accessibility.getFullAXTree();
    nodes = result?.nodes ?? [];
  } catch (e) {
    logDebug(`[GridFill] getFullAXTree failed: ${e}`);
    return null;
  }

  // Google Sheets exposes cells with role="gridcell" and name like "A1" or "Row 1, Column A"
  // Prefer exact name match first, then fall back to positional match
  const colLetter = String.fromCharCode(65 + parsed.col);
  const rowNum = parsed.row + 1;
  const exactLabel = `${colLetter}${rowNum}`;
  const altLabel = `Row ${rowNum}, Column ${colLetter}`;

  const cellNode = nodes.find((n: any) => {
    if (n.ignored) return false;
    const role = (n.role?.value || '').toLowerCase();
    if (role !== 'gridcell' && role !== 'cell') return false;
    const name = n.name?.value || '';
    return name === exactLabel || name.startsWith(exactLabel + ' ') ||
           name === altLabel || name.includes(exactLabel);
  });

  if (!cellNode?.backendDOMNodeId) return null;

  // Resolve to screen coordinates via DOM.getBoxModel
  try {
    const { nodeIds } = await session.DOM.pushNodesByBackendIdsToFrontend({
      backendNodeIds: [cellNode.backendDOMNodeId],
    });
    if (!nodeIds?.[0]) return null;
    const { model } = await session.DOM.getBoxModel({ nodeId: nodeIds[0] });
    if (model?.content) {
      const c = model.content;
      return { x: Math.round((c[0] + c[4]) / 2), y: Math.round((c[1] + c[5]) / 2) };
    }
  } catch (e) {
    logDebug(`[GridFill] Box model resolution failed: ${e}`);
  }
  return null;
}

/** Type a string into a focused element using CDP Input.dispatchKeyEvent (bypasses DOM). */
async function cdpTypeString(session: CDP.Client, text: string): Promise<void> {
  for (const char of text) {
    const code = char.charCodeAt(0);
    const params = {
      type: "keyDown" as const,
      key: char,
      text: char,
      unmodifiedText: char,
      windowsVirtualKeyCode: code,
      nativeVirtualKeyCode: code,
    };
    await session.Input.dispatchKeyEvent(params);
    await session.Input.dispatchKeyEvent({ ...params, type: "char" as const });
    await session.Input.dispatchKeyEvent({ ...params, type: "keyUp" as const });
  }
}

/** Confirm a cell write by pressing Tab to move to the next cell (commits value). */
async function cdpCommitCell(session: CDP.Client): Promise<void> {
  const tabParams = {
    type: "keyDown" as const,
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  };
  await session.Input.dispatchKeyEvent(tabParams);
  await session.Input.dispatchKeyEvent({ ...tabParams, type: "keyUp" as const });
}

/** Execute grid fill for Google Sheets or canvas-rendered spreadsheets. */
async function gridFill(
  session: CDP.Client,
  cells: GridCell[]
): Promise<FillResult> {
  const startMs = Date.now();
  const results: FillResult["results"] = [];

  for (const cell of cells) {
    const coords = await findSheetCellCoords(session, cell.cell);
    if (!coords) {
      logAction("browser_fill", cell.cell, "FAIL — cell not found in AX tree");
      results.push({
        ref: cell.cell,
        field_type: "gridcell",
        success: false,
        message: `Cell ${cell.cell} not found in accessibility tree — ensure the sheet is loaded and cell is visible`,
      });
      continue;
    }

    try {
      // Click the cell to focus it
      await session.Input.dispatchMouseEvent({ type: "mousePressed", x: coords.x, y: coords.y, button: "left", clickCount: 1 });
      await session.Input.dispatchMouseEvent({ type: "mouseReleased", x: coords.x, y: coords.y, button: "left", clickCount: 1 });

      // Small pause to let the cell enter edit mode
      await new Promise(r => setTimeout(r, 80));

      // Type value via CDP key events
      await cdpTypeString(session, cell.value);

      // Commit with Tab
      await cdpCommitCell(session);

      logAction("browser_fill", cell.cell, `gridcell: OK — wrote "${cell.value}" at (${coords.x},${coords.y})`);
      results.push({
        ref: cell.cell,
        field_type: "gridcell",
        success: true,
        message: `Written at (${coords.x},${coords.y})`,
        value: cell.value,
      });
    } catch (e: any) {
      logAction("browser_fill", cell.cell, `gridcell: FAIL — ${e.message}`);
      results.push({
        ref: cell.cell,
        field_type: "gridcell",
        success: false,
        message: `CDP error: ${e.message}`,
      });
    }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  return {
    success: failed === 0,
    total_fields: cells.length,
    succeeded,
    failed,
    submitted: false,
    results,
    execution_ms: Date.now() - startMs,
  };
}

export async function browserFill(
  session: CDP.Client,
  options: FillOptions,
  config: Config
): Promise<FillResult> {
  // ── Cross-tool loop detection (catches click→fill→click→fill patterns) ──
  const crossLoopCheck = detectCrossToolLoop();
  if (crossLoopCheck.stuck) {
    return {
      success: false,
      total_fields: 0,
      succeeded: 0,
      failed: 0,
      submitted: false,
      results: [],
      execution_ms: 0,
      suggestedNext: crossLoopCheck.diagnosis,
    };
  }

  // ── Single-tool stuck loop detection ──
  const stuckCheck = detectStuckLoop();
  if (stuckCheck.stuck) {
    return {
      success: false,
      total_fields: 0,
      succeeded: 0,
      failed: 0,
      submitted: false,
      results: [],
      execution_ms: 0,
      suggestedNext: stuckCheck.diagnosis || "browser_fill is stuck in a loop. Call browser_map() to re-read the page and try a different approach.",
    };
  }

  // Track this call for loop detection
  const fillTarget = options.fields?.map(f => f.ref).join(',') || 'grid';
  trackToolCall('browser_fill', fillTarget, {});

  // ── grid_data: Google Sheets / canvas spreadsheet filling ──
  if (options.grid_data && options.grid_data.length > 0) {
    return gridFill(session, options.grid_data);
  }

  const startMs = Date.now();
  const results: FillResult["results"] = [];

  if (!options.fields || options.fields.length === 0) {
    return { success: false, total_fields: 0, succeeded: 0, failed: 0, submitted: false, results: [], execution_ms: 0, suggestedNext: "No fields provided. Use browser_map() to get field ref IDs, then call browser_fill with fields:[{ref:'w:NN', value:'...'}]." };
  }

  // ── scan_only: return field schema without mutating DOM ──
  if (options.scan_only) {
    for (const field of options.fields) {
      const selector = toSelector(field.ref);
      const detected = await detectFieldType(session, selector);
      // Report success=false for non-fillable fields (disabled, readonly, unknown
      // type) so scan mode doesn't give false confidence before the actual fill.
      const scanSuccess = detected.exists && detected.type !== "unknown" && detected.fillable !== false;
      const scanMsg = !detected.exists
        ? "Element not found"
        : detected.type === "unknown"
        ? "Unsupported field type — fill will fail"
        : !detected.fillable
        ? `Detected: ${detected.type} (not fillable — disabled or readonly)`
        : `Detected: ${detected.type}`;
      results.push({
        ref: field.ref,
        field_type: detected.exists ? detected.type : "not_found",
        success: scanSuccess,
        message: scanMsg,
      });
    }
    return {
      success: true,
      total_fields: options.fields.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
      submitted: false,
      results,
      execution_ms: Date.now() - startMs,
    };
  }

  // ── blast_mode: bulk fill in single CDP roundtrip ──
  if (options.blast_mode) {
    // blast_mode: single CDP round-trip filling all fields at once.
    // Handles text, checkbox, radio, select, contenteditable, and ARIA variants.
    const blastExpression = `(function(fields) {
      var results = [];
      fields.forEach(function(f) {
        var el = document.querySelector(f.selector);
        if (!el) { results.push({ ref: f.ref, ok: false, msg: 'not found', type: 'unknown' }); return; }
        var tag = el.tagName.toLowerCase();
        var inputType = (el.getAttribute('type') || '').toLowerCase();
        var role = (el.getAttribute('role') || '').toLowerCase();
        try {
          if (tag === 'select') {
            // Select element
            var foundIdx = -1;
            for (var j = 0; j < el.options.length; j++) {
              var opt = el.options[j];
              if (opt.value === f.value || opt.text === f.value || opt.text.trim() === f.value.trim()) { foundIdx = j; break; }
            }
            if (foundIdx === -1) { results.push({ ref: f.ref, ok: false, msg: 'Option not found: ' + f.value, type: 'select' }); return; }
            var nativeSS = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
            if (nativeSS) nativeSS.call(el, el.options[foundIdx].value); else el.selectedIndex = foundIdx;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            results.push({ ref: f.ref, ok: true, msg: 'selected:' + el.options[foundIdx].text, type: 'select' });
          } else if (tag === 'input' && inputType === 'checkbox') {
            // Native checkbox
            var want = f.value === 'true' || f.value === 'yes' || f.value === 'checked' || f.value === '1' || f.value === 'on';
            if (el.checked !== want) {
              var ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
              if (ns) ns.call(el, want); else el.checked = want;
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            results.push({ ref: f.ref, ok: true, msg: want ? 'checked' : 'unchecked', type: 'checkbox' });
          } else if (tag === 'input' && inputType === 'radio') {
            // Native radio
            if (!el.checked) {
              var nsr = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked')?.set;
              if (nsr) nsr.call(el, true); else el.checked = true;
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            results.push({ ref: f.ref, ok: true, msg: 'selected', type: 'radio' });
          } else if (role === 'checkbox' || role === 'switch') {
            // ARIA custom checkbox
            var wantAria = f.value === 'true' || f.value === 'yes' || f.value === 'checked' || f.value === '1' || f.value === 'on';
            var curAria = el.getAttribute('aria-checked') === 'true';
            if (curAria !== wantAria) {
              el.setAttribute('aria-checked', wantAria ? 'true' : 'false');
              el.click();
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            results.push({ ref: f.ref, ok: true, msg: wantAria ? 'checked' : 'unchecked', type: 'custom-checkbox' });
          } else if (role === 'radio') {
            // ARIA custom radio
            if (el.getAttribute('aria-checked') !== 'true') {
              el.setAttribute('aria-checked', 'true');
              el.click();
              el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
            results.push({ ref: f.ref, ok: true, msg: 'selected', type: 'custom-radio' });
          } else if (el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') {
            // contenteditable
            el.focus();
            el.textContent = f.value;
            try { document.execCommand('selectAll', false, null); document.execCommand('insertText', false, f.value); } catch(e2) {}
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: f.value, inputType: 'insertText' }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            results.push({ ref: f.ref, ok: true, msg: 'filled', type: 'contenteditable' });
          } else {
            // text / textarea / other inputs
            el.focus();
            var proto2 = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            var ns2 = Object.getOwnPropertyDescriptor(proto2, 'value')?.set;
            if (ns2) ns2.call(el, f.value); else el.value = f.value;
            el.dispatchEvent(new InputEvent('input', { bubbles: true, data: f.value, inputType: 'insertText' }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            results.push({ ref: f.ref, ok: true, msg: 'filled', type: tag });
          }
        } catch(e) { results.push({ ref: f.ref, ok: false, msg: e.message || String(e), type: tag }); }
      });
      return JSON.stringify(results);
    })(${JSON.stringify(options.fields.map(f => ({ ref: f.ref, selector: toSelector(f.ref), value: f.value })))})`;
    
    const { result } = await session.Runtime.evaluate({ expression: blastExpression, returnByValue: true });
    const blastResults = JSON.parse((result?.value as string) || '[]');
    
    for (const r of blastResults) {
      results.push({
        ref: r.ref,
        field_type: r.type,
        success: r.ok,
        message: r.ok ? r.msg : `FAIL — ${r.msg}`,
        value: options.fields.find(f => f.ref === r.ref)?.value,
      });
      if (!r.ok) logAction("browser_fill", r.ref, `${r.type}: FAIL — ${r.msg}`);
      else logAction("browser_fill", r.ref, `${r.type}: OK — ${r.msg}`);
    }
  } else {
    for (const field of options.fields) {
      const selector = toSelector(field.ref);

    // ── Pre-fill actionability gate (Playwright strategy) ─────────────────────
    // Text + select fields on complex sites can be under overlays or still animating.
    // Verify visibility, stability, and clear hit-target before writing.
    const actResult = await verifyActionability(session, selector, {
      stabilityTimeoutMs: 250,
      totalTimeoutMs: 1200,
    });
    if (actResult.status === 'OCCLUDED' && !actResult.occludedBy?.isWeavetabOwned) {
      const occ = actResult.occludedBy!;
      const blockerStr = `<${occ.tag}${occ.id ? '#'+occ.id : ''}> intercepts pointer events`;
      results.push({ ref: field.ref, field_type: "unknown", success: false, message: `Field blocked by overlay: ${blockerStr}` });
      logAction("browser_fill", field.ref, `FAIL — occluded: ${blockerStr}`);
      continue;
    }
    if (actResult.status === 'INVISIBLE') {
      results.push({ ref: field.ref, field_type: "unknown", success: false, message: "Field is not visible — scroll to reveal it before filling" });
      logAction("browser_fill", field.ref, "FAIL — invisible");
      continue;
    }

    // 1. Detect field type
    const detected = await detectFieldType(session, selector);
    if (!detected.exists) {
      results.push({ ref: field.ref, field_type: "unknown", success: false, message: "Element not found" });
      logAction("browser_fill", field.ref, "unknown: FAIL — Element not found");
      continue;
    }
    const type = detected.type;
    if (type === "unknown") {
      results.push({ ref: field.ref, field_type: "unknown", success: false, message: "Unsupported field type" });
      logAction("browser_fill", field.ref, "unknown: FAIL — Unsupported field type");
      continue;
    }

    // 2. Snapshot before
    const before = await getFieldState(session, selector, type);
    let actionOk = true;
    let actionMsg = "";
    
    // Build a success predicate based on the desired target value so that:
    // (a) already-correct fields don't falsely fail (before === after but value IS correct)
    // (b) framework-reverted fields are still caught
    function buildCheckSuccess(fieldType: string, desiredValue: string): (after: Record<string, string>) => boolean {
      if (fieldType === 'checkbox' || fieldType === 'custom-checkbox') {
        const want = desiredValue === 'true' || desiredValue === 'yes' || desiredValue === 'checked' || desiredValue === '1' || desiredValue === 'on';
        return (after) => (after.checked === 'true') === want;
      }
      if (fieldType === 'radio' || fieldType === 'custom-radio') {
        return (after) => after.checked === 'true';
      }
      if (fieldType === 'select') {
        return (after) => after.value === desiredValue || after.text === desiredValue || (after.text || '').trim() === desiredValue.trim();
      }
      // text / contenteditable
      return (after) => (after.value === desiredValue || after.text === desiredValue);
    }

    // 4. Confirm via settle+verify — catches React/Vue handlers that revert the change.
    //    We pass the 'before' snapshot we already took, and applyFieldValue as the action.
    //    Uses a checkSuccess predicate so already-correct values are not false-negatives.
    const confirm = await confirmChange(
      session,
      () => getFieldState(session, selector, type),
      async () => {
        const applied = await applyFieldValue(session, selector, field.value, type);
        actionOk = applied.ok;
        actionMsg = applied.msg;
      },
      {
        precomputedBefore: before,
        verifyPasses: [15, 50, 150],
        checkSuccess: buildCheckSuccess(type, field.value),
      }
    );

    if (!actionOk) {
      results.push({ ref: field.ref, field_type: type, success: false, message: actionMsg });
      logAction("browser_fill", field.ref, `${type}: FAIL — ${actionMsg}`);
      continue;
    }

    if (confirm.applied) {
      results.push({
        ref: field.ref,
        field_type: type,
        success: true,
        message: `${actionMsg} (verified after ${confirm.settleMs}ms)`,
        value: detected.isSecret ? "[REDACTED]" : field.value,
      });
      logAction("browser_fill", field.ref, `${type}: OK — ${actionMsg}`);
    } else {
      // Field reverted — framework rejected the value (e.g., controlled component)
      results.push({
        ref: field.ref,
        field_type: type,
        success: false,
        message: `Value not retained — framework may have reverted it (before=${detected.isSecret ? '"[REDACTED]"' : JSON.stringify(before)}, after=${detected.isSecret ? '"[REDACTED]"' : JSON.stringify(confirm.after)})`,
      });
      logAction("browser_fill", field.ref, `${type}: FAIL — reverted by framework`);
    }
  }
  }

  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  let submitted = false;
  if (options.submit && failed === 0) {
    const subSelector = toSelector(options.submit);
    const { result: subResult } = await session.Runtime.evaluate({
      expression: `(function(sel) {
        try {
          var el = document.querySelector(sel);
          if (!el) return 'not found';
          el.focus();
          el.click();
          el.dispatchEvent(new Event('click', { bubbles: true }));
          return 'clicked';
        } catch(e) { return e.message; }
      })(${esc(subSelector)})`,
      returnByValue: true,
    });
    submitted = subResult?.value === "clicked";
  }

  const totalMs = Date.now() - startMs;

  recordAction({
    timestamp: new Date().toISOString(),
    tool: "browser_fill",
    input: { fieldCount: options.fields.length, submit: !!options.submit },
    result: { success: failed === 0, total: options.fields.length, succeeded, failed },
  });

  return {
    success: failed === 0,
    total_fields: options.fields.length,
    succeeded,
    failed,
    submitted,
    results,
    execution_ms: totalMs,
  };
}
