import { logDebug } from "../audit/logger.js";
import CDP from "chrome-remote-interface";
import { SessionSecretTracker } from "../security/secrets.js";

// ─── Message queue with backpressure ──────────────────────────────────────────

interface QueuedMessage {
  id: string;
  message: object;
  resolve: (value: boolean) => void;
  timestamp: number;
  attempts: number;
}

const MAX_QUEUE_SIZE = 50;
const BATCH_INTERVAL_MS = 10;  // Reduced from 20ms for faster message delivery

const messageQueues = new Map<string, QueuedMessage[]>();
const queueTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function drainQueue(session: CDP.Client, targetId: string): Promise<void> {
  const queue = messageQueues.get(targetId);
  if (!queue || queue.length === 0) return;

  const batch = queue.splice(0, Math.min(queue.length, 10));
  const messages = batch.map((q, i) => {
    const msg = q.message as Record<string, unknown>;
    // Add dedup _id using queue entry's id (unique) so content.js __wt_processedMsgIds works
    if (typeof msg === 'object' && msg !== null) {
      msg._id = q.id + (i > 0 ? '-' + i : '');
    }
    return msg;
  });

  try {
    const msgData = JSON.stringify(messages.length === 1 ? messages[0] : messages);
    await session.Runtime.evaluate({
      expression: `
        try {
          window.postMessage({ type: 'Weavetab-msg-in', data: ${msgData} }, '*');
        } catch(e) {}
      `
    });
    batch.forEach(q => q.resolve(true));
  } catch (e) {
    logDebug(`[Weavetab] Failed to send batch (${batch.length} msgs)`, e);
    batch.forEach(q => {
      q.attempts++;
      if (q.attempts < 3) {
        queue.push(q); // re-queue for retry
      } else {
        q.resolve(false);
      }
    });
  }

  // Schedule next drain if messages remain
  if (queue.length > 0) {
    const timer = setTimeout(() => drainQueue(session, targetId), BATCH_INTERVAL_MS);
    queueTimers.set(targetId, timer);
  } else {
    const t = queueTimers.get(targetId);
    if (t) { clearTimeout(t); queueTimers.delete(targetId); }
  }
}

function enqueueMessage(session: CDP.Client, targetId: string, message: object): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let queue = messageQueues.get(targetId);
    if (!queue) {
      queue = [];
      messageQueues.set(targetId, queue);
    }

    // Backpressure: if queue is full, reject oldest message to make room
    if (queue.length >= MAX_QUEUE_SIZE) {
      const dropped = queue.shift();
      if (dropped) {
        logDebug(`[Weavetab] Backpressure: dropping oldest message (${dropped.id})`);
        dropped.resolve(false);
      }
    }

    const qMsg: QueuedMessage = {
      id: Math.random().toString(36).slice(2, 10),
      message,
      resolve,
      timestamp: Date.now(),
      attempts: 0,
    };
    queue.push(qMsg);

    // Start drain timer if not already running
    if (!queueTimers.has(targetId)) {
      const timer = setTimeout(() => drainQueue(session, targetId), BATCH_INTERVAL_MS);
      queueTimers.set(targetId, timer);
    }
  });
}

// ─── Public API ───────────────────────────────────────────────────────────────

function getTargetId(session: CDP.Client): string {
  return (session as any)._targetId || (session as any).targetId || "default";
}

/**
 * sendToExtension is the only bridge to communicate from Node (CLI)
 * to the Weavetab Chrome Extension via CDP executeScript.
 * Messages are queued and batched with backpressure.
 * Returns true if the message was queued, false if dropped.
 */
export async function sendToExtension(session: CDP.Client, message: object): Promise<boolean> {
  try {
    const targetId = getTargetId(session);
    return await enqueueMessage(session, targetId, message);
  } catch (e) {
    logDebug("[Weavetab] Failed to sendToExtension", e);
    return false;
  }
}

export async function getFromExtension<T = any>(session: CDP.Client, message: object, retries = 0): Promise<T | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { result } = await session.Runtime.evaluate({
        expression: `new Promise((resolve) => {
          try {
            const id = Math.random().toString();
            const listener = (e) => {
              if (e.detail && e.detail.id === id) {
                window.removeEventListener('Weavetab-msg-out', listener);
                resolve(JSON.stringify(e.detail.data));
              }
            };
            window.addEventListener('Weavetab-msg-out', listener);
            window.dispatchEvent(new CustomEvent('Weavetab-msg-in', { detail: Object.assign({}, ${JSON.stringify(message)}, { id }) }));
            
            // Fallback timeout — 100ms fail-fast (reduced from 150ms)
            setTimeout(() => {
              window.removeEventListener('Weavetab-msg-out', listener);
              resolve("null");
            }, 100);
          } catch (e) {
            resolve("null");
          }
        })`,
        awaitPromise: true,
        returnByValue: true
      });
      if (result && result.value && result.value !== "null") {
        return JSON.parse(result.value as string);
      }
      // Got null — if we have retries left, try again
      if (attempt < retries) {
        logDebug(`[Weavetab] Extension did not respond (attempt ${attempt + 1}/${retries + 1}), retrying...`);
        continue;
      }
    } catch (e) {
      if (attempt < retries) {
        logDebug(`[Weavetab] getFromExtension error (attempt ${attempt + 1}/${retries + 1}): ${e instanceof Error ? e.message : e}`);
        continue;
      }
      logDebug("[Weavetab] Failed to getFromExtension after retries", e);
    }
  }
  return null;
}

export async function hideWeaveTabOverlay(session: CDP.Client): Promise<void> {
  await session.Runtime.evaluate({
    expression: `(function(){
      var existing = document.getElementById('__wt_hide_overlay_styles');
      if (existing) return; // already hidden
      var style = document.createElement('style');
      style.id = '__wt_hide_overlay_styles';
      // Cover ALL Weavetab overlay elements so they never appear in screenshots/PDFs/snapshots:
      //  - [id^="Weavetab-"]    : Weavetab-root shadow host, any legacy Weavetab- elements
      //  - [id^="__Weavetab_"]  : __Weavetab_cursor_host (ghost cursor)
      //  - [id^="wt-"]          : wt-* legacy element IDs
      //  - [data-wt-internal]   : HUD iframe host (closed shadow DOM mount)
      //  - [data-wt-ignore]     : any element flagged as agent-invisible
      //  - .wt-bubble           : thought bubble / action text popups
      //  - #__wt_ask_bridge     : question input bridge element
      //  - #wt-debug-overlay    : debug overlay panel
      //  - #wt-main-container   : WeaveTab OS panel (todos + chat)
      style.textContent = [
        '[id^="Weavetab-"]',
        '[id^="__Weavetab_"]',
        '[id^="wt-"]',
        '[data-wt-internal]',
        '[data-wt-ignore]',
        '.wt-bubble',
        '#__wt_ask_bridge',
        '#wt-debug-overlay',
        '#wt-main-container',
      ].join(', ') + ' { display: none !important; visibility: hidden !important; opacity: 0 !important; }';
      document.head.appendChild(style);
    })()`,
    returnByValue: false,
  }).catch(() => {});
}

export async function restoreWeaveTabOverlay(session: CDP.Client): Promise<void> {
  await session.Runtime.evaluate({
    expression: `(function(){
      var style = document.getElementById('__wt_hide_overlay_styles');
      if (style) style.remove();
    })()`,
    returnByValue: false,
  }).catch(() => {});
}

// ─── Secret Hardening & Containment Helpers ──────────────────────────────────

export async function applySecretHardening(
  session: CDP.Client,
  objectId?: string,
  selector?: string
): Promise<void> {
  const hardeningScript = `function() {
    try {
      const el = this;
      if (!el) return;
      // Mark as secret
      try { el.setAttribute('data-wt-secret', 'true'); } catch (_) {}
      
      // 1. Redact direct .value access via instance-level property override
      const proto = Object.getPrototypeOf(el);
      const origDesc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (origDesc) {
        Object.defineProperty(el, 'value', {
          get: function() { return '[REDACTED]'; },
          set: origDesc.set,
          configurable: true,
          enumerable: true
        });
      }
      
      // 2. Defeat array spread, iteration, and coercion
      try {
        Object.defineProperty(el, Symbol.iterator, {
          value: function* () { yield '[REDACTED]'; },
          configurable: true
        });
        Object.defineProperty(el, Symbol.toPrimitive, {
          value: function() { return '[REDACTED]'; },
          configurable: true
        });
        // Defeat JSON.stringify / structuredClone leaks
        Object.defineProperty(el, 'toJSON', {
          value: function() { return '[REDACTED]'; },
          configurable: true
        });
      } catch(_) {}
    } catch (e) {
      // fail silently so as not to disrupt the page execution
    }
  }`;

  if (objectId) {
    await session.Runtime.callFunctionOn({
      functionDeclaration: hardeningScript,
      objectId,
      silent: true
    }).catch(() => {});
  } else if (selector) {
    await session.Runtime.evaluate({
      expression: `(function(sel) {
        const el = document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
        if (el) {
          (${hardeningScript}).call(el);
        }
      })(${JSON.stringify(selector)})`,
      returnByValue: false
    }).catch(() => {});
  }
}

export async function registerAndHardenSecretField(
  session: CDP.Client,
  targetId: string,
  selector: string,
  secretValue?: string,
  objectId?: string
): Promise<void> {
  try {
    if (secretValue) {
      SessionSecretTracker.registerSecretValue(targetId, secretValue);
    }

    let resolvedObjectId = objectId;
    if (!resolvedObjectId && selector) {
      const nodeInfo = await session.Runtime.evaluate({
        expression: `(function(sel) {
          return document.querySelector(sel) || (window.__Weavetab_shadowQuery ? window.__Weavetab_shadowQuery(sel) : null);
        })(${JSON.stringify(selector)})`,
        returnByValue: false
      }).catch(() => null);
      resolvedObjectId = nodeInfo?.result?.objectId;
    }

    if (resolvedObjectId) {
      try {
        const nodeDetails = await session.DOM.requestNode({ objectId: resolvedObjectId });
        if (nodeDetails?.nodeId) {
          const desc = await session.DOM.describeNode({ nodeId: nodeDetails.nodeId });
          if (desc?.node?.backendNodeId) {
            SessionSecretTracker.markNodeAsSecret(targetId, desc.node.backendNodeId);
          }
        }
      } catch { /* DOM lookup best-effort */ }
    }

    await applySecretHardening(session, resolvedObjectId, selector);
  } catch (err) {
    logDebug(`[Weavetab] registerAndHardenSecretField failed: ${err}`);
  }
}

export async function maskSecretFieldsForCapture(session: CDP.Client): Promise<void> {
  await session.Runtime.evaluate({
    expression: `(function() {
      var secretRegex = /password|passcode|pin|passphrase|secret|token|auth.?key|access.?code|mot.?de.?passe|contrase[nñ]a|kennwort|senha/i;
      
      function queryAllDeep(root, matchFn) {
        var matched = [];
        var elements = root.querySelectorAll('*');
        for (var i = 0; i < elements.length; i++) {
          var el = elements[i];
          if (matchFn(el)) matched.push(el);
          if (el.shadowRoot) {
            matched = matched.concat(queryAllDeep(el.shadowRoot, matchFn));
          }
        }
        return matched;
      }

      function isSecretNode(el) {
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

      var els = queryAllDeep(document, isSecretNode);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        el.__wt_cap_val_backup = el.value;
        try { el.value = ''; } catch(e) {}
        if (el.isContentEditable) {
          el.__wt_cap_txt_backup = el.textContent;
          try { el.textContent = ''; } catch(e) {}
        }
        el.__wt_cap_sec_backup = el.style.webkitTextSecurity;
        try { el.style.webkitTextSecurity = 'disc'; } catch(e) {}
      }
    })()`,
    returnByValue: false,
  }).catch(() => {});
}

export async function restoreSecretFieldsAfterCapture(session: CDP.Client): Promise<void> {
  await session.Runtime.evaluate({
    expression: `(function() {
      function queryAllDeep(root) {
        var matched = [];
        var elements = root.querySelectorAll('*');
        for (var i = 0; i < elements.length; i++) {
          var el = elements[i];
          if (el.__wt_cap_val_backup !== undefined || el.__wt_cap_txt_backup !== undefined || el.__wt_cap_sec_backup !== undefined) {
            matched.push(el);
          }
          if (el.shadowRoot) {
            matched = matched.concat(queryAllDeep(el.shadowRoot));
          }
        }
        return matched;
      }

      var els = queryAllDeep(document);
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.__wt_cap_val_backup !== undefined) {
          try { el.value = el.__wt_cap_val_backup; } catch(e) {}
          delete el.__wt_cap_val_backup;
        }
        if (el.__wt_cap_txt_backup !== undefined) {
          try { el.textContent = el.__wt_cap_txt_backup; } catch(e) {}
          delete el.__wt_cap_txt_backup;
        }
        if (el.__wt_cap_sec_backup !== undefined) {
          try { el.style.webkitTextSecurity = el.__wt_cap_sec_backup; } catch(e) {}
          delete el.__wt_cap_sec_backup;
        }
      }
    })()`,
    returnByValue: false,
  }).catch(() => {});
}
