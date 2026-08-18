/**
 * Weavetab — tools/automation.ts
 * browser_automation: Persistent injected scripts that run independently inside the browser.
 * The agent does NOT wait for results in a loop — scripts run at browser speed.
 * Weavetab by fy2ne
 *
 * Design (anti-pattern #5 safe):
 * - automationRegistry (server-side Map) is the SINGLE source of truth for script metadata.
 * - Page-side uses closure state for loop lifecycle — no window.__wt_automations registry.
 * - Stop signal uses a minimal window boolean per automation (same pattern as __wt_stop_requested in server.ts).
 * - Result mailbox uses a window array per automation (single-purpose, not a registry map).
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { logAction } from "../audit/logger.js";

export interface AutomationOptions {
  action: "start" | "stop" | "list" | "poll";
  id?: string;
  script?: string;
  persistent?: boolean;
  onResult?: "notify_agent" | "store" | "ignore";
}

interface AutomationScript {
  id: string;
  script: string;
  persistent: boolean;
  onResult: "notify_agent" | "store" | "ignore";
  startedAt: string;
  active: boolean;
}

// Server-side registry — the ONLY source of truth for script metadata.
// Page must NOT hold agent state (anti-pattern #5).
const automationRegistry = new Map<string, AutomationScript>();

// Server-side result buffer for scripts with onResult="notify_agent".
// Harvested from page mailboxes by list/poll.
const resultQueue: Array<{ id: string; data: any; timestamp: string }> = [];

function stopSignalKey(id: string): string {
  return `__wt_auto_stop_${id}`;
}

function resultMailboxKey(id: string): string {
  return `__wt_auto_out_${id}`;
}

export async function browserAutomation(
  session: CDP.Client,
  options: AutomationOptions,
  _config: Config
): Promise<{ success: boolean; automations?: AutomationScript[]; results?: any[]; error?: string }> {
  const { action, id, script, persistent = false, onResult = "store" } = options;

  if (action === "start") {
    if (!id) return { success: false, error: "browser_automation start requires an 'id'" };
    if (!script) return { success: false, error: "browser_automation start requires a 'script'" };

    // Clear any previous stop signal for this id
    await session.Runtime.evaluate({
      expression: `(function() { delete window[${JSON.stringify(stopSignalKey(id))}]; delete window[${JSON.stringify(resultMailboxKey(id))}]; })()`,
      returnByValue: true,
    }).catch(() => {});

    // Wrap the script in an IIFE using ONLY closure state for lifecycle.
    // No window.__wt_automations map. Stop signal read from a window boolean.
    // Results written to a window array per automation (mailbox, not registry).
    const wrappedScript = `
(function() {
  var _id = ${JSON.stringify(id)};
  var _persistent = ${JSON.stringify(persistent)};
  var _onResult = ${JSON.stringify(onResult)};
  var _active = true;
  var _resultMailbox = window[${JSON.stringify(resultMailboxKey(id))}];
  var wt = {
    query: function(sel) {
      return document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
    },
    click: function(sel) {
      var el = this.query(sel);
      if (el) el.click();
    },
    fill: function(sel, val) {
      var el = this.query(sel);
      if (el) { 
        el.value = val; 
        el.dispatchEvent(new Event('input', {bubbles:true})); 
        el.dispatchEvent(new Event('change', {bubbles:true})); 
      }
    }
  };

  // Create result mailbox as a plain array on window — single-purpose, not a registry
  if (!_resultMailbox) {
    _resultMailbox = [];
    Object.defineProperty(window, ${JSON.stringify(resultMailboxKey(id))}, {
      value: _resultMailbox,
      writable: true,
      configurable: true,
      enumerable: false
    });
  }

  function _report(data) {
    var safeData;
    try { JSON.stringify(data); safeData = data; } catch(e) { safeData = String(data); }
    _resultMailbox.push({ data: safeData, timestamp: new Date().toISOString() });
  }

  function _checkStop() {
    return window[${JSON.stringify(stopSignalKey(id))}] === true;
  }

  function _run() {
    if (!_active) return;
    if (_checkStop()) { _active = false; return; }
    (async function() { return eval(${JSON.stringify(script)}); })().then(function(r) {
      if (r !== undefined && _onResult !== 'ignore') _report(r);
    }).catch(function(e) {
      if (_onResult !== 'ignore') _report({ error: e.message || String(e) });
    }).finally(function() {
      if (_persistent && _active) {
        setTimeout(_run, 100);
      }
    });
  }

  if (_persistent) {
    _run();
  } else {
    (async function() { return eval(${JSON.stringify(script)}); })().then(function(r) {
      if (r !== undefined && _onResult !== 'ignore') _report(r);
      window[${JSON.stringify(stopSignalKey(id))}] = true;
    }).catch(function(e) {
      if (_onResult !== 'ignore') _report({ error: e.message || String(e) });
      window[${JSON.stringify(stopSignalKey(id))}] = true;
    });
  }
})();`;

    const resp = await session.Runtime.evaluate({
      expression: wrappedScript,
      returnByValue: true,
      awaitPromise: false,
    });

    if (resp.exceptionDetails) {
      return {
        success: false,
        error: resp.exceptionDetails.exception?.description || resp.exceptionDetails.text,
      };
    }

    if (persistent) {
      try {
        await session.Page.addScriptToEvaluateOnNewDocument({ source: wrappedScript });
      } catch (_e) {
        // Fallback gracefully if Page domain isn't enabled
      }
    }

    automationRegistry.set(id, {
      id,
      script,
      persistent,
      onResult,
      startedAt: new Date().toISOString(),
      active: true,
    });

    logAction("browser_automation", id, `started (persistent: ${persistent})`);
    return { success: true, automations: [automationRegistry.get(id)!] };
  }

  if (action === "stop") {
    if (!id) return { success: false, error: "browser_automation stop requires an 'id'" };

    // Set stop signal boolean on window (single-purpose, same pattern as __wt_stop_requested)
    // The running IIFE checks this flag on each iteration and exits when set.
    await session.Runtime.evaluate({
      expression: `(function() {
        window[${JSON.stringify(stopSignalKey(id))}] = true;
        // Also clear the result mailbox
        delete window[${JSON.stringify(resultMailboxKey(id))}];
      })()`,
      returnByValue: true,
    }).catch(() => {});

    automationRegistry.delete(id);
    logAction("browser_automation", id, "stopped");
    return { success: true, automations: Array.from(automationRegistry.values()) };
  }

  if (action === "list") {
    // Check active status by testing the stop signal
    for (const [autoId] of automationRegistry) {
      try {
        const resp = await session.Runtime.evaluate({
          expression: `(function() { return window[${JSON.stringify(stopSignalKey(autoId))}] === true; })()`,
          returnByValue: true,
        });
        const entry = automationRegistry.get(autoId);
        if (entry) entry.active = resp.result?.value !== true;
      } catch {
        const entry = automationRegistry.get(autoId);
        if (entry) entry.active = false;
      }
    }

    // Collect pending results from all mailboxes
    for (const [autoId] of automationRegistry) {
      try {
        const resp = await session.Runtime.evaluate({
          expression: `(function() {
            var mb = window[${JSON.stringify(resultMailboxKey(autoId))}];
            if (!mb || mb.length === 0) return '[]';
            var items = mb.splice(0, mb.length);
            return JSON.stringify(items);
          })()`,
          returnByValue: true,
        });
        if (resp.result?.value) {
          const items = JSON.parse(resp.result.value as string) as Array<{ data: any; timestamp: string }>;
          for (const item of items) {
            resultQueue.push({ id: autoId, data: item.data, timestamp: item.timestamp });
          }
        }
      } catch { /* ignore */ }
    }

    return {
      success: true,
      automations: Array.from(automationRegistry.values()),
    };
  }

  if (action === "poll") {
    // Collect all pending results from mailboxes, then drain server queue
    for (const [autoId] of automationRegistry) {
      try {
        const resp = await session.Runtime.evaluate({
          expression: `(function() {
            var mb = window[${JSON.stringify(resultMailboxKey(autoId))}];
            if (!mb || mb.length === 0) return '[]';
            var items = mb.splice(0, mb.length);
            return JSON.stringify(items);
          })()`,
          returnByValue: true,
        });
        if (resp.result?.value) {
          const items = JSON.parse(resp.result.value as string) as Array<{ data: any; timestamp: string }>;
          for (const item of items) {
            resultQueue.push({ id: autoId, data: item.data, timestamp: item.timestamp });
          }
        }
      } catch { /* ignore */ }
    }

    const results = resultQueue.splice(0, resultQueue.length);
    return { success: true, results };
  }

  return { success: false, error: `Unknown action: ${action}` };
}
