import { logDebug } from "../audit/logger.js";
import CDP from "chrome-remote-interface";
import { SessionSecretTracker } from "../security/secrets.js";

interface QueuedMessage {
  id: string;
  message: object;
  resolve: (value: boolean) => void;
  timestamp: number;
  attempts: number;
}

const MAX_QUEUE_SIZE = 50;
const BATCH_INTERVAL_MS = 10;

const messageQueues = new WeakMap<CDP.Client, QueuedMessage[]>();
const queueTimers = new WeakMap<CDP.Client, ReturnType<typeof setTimeout>>();

async function drainQueue(session: CDP.Client): Promise<void> {
  const queue = messageQueues.get(session);
  if (!queue || queue.length === 0) return;

  const batch = queue.splice(0, Math.min(queue.length, 10));
  const messages = batch.map((q, i) => {
    const msg = q.message as Record<string, unknown>;
    if (typeof msg === "object" && msg !== null) {
      return {
        ...msg,
        _id: q.id + (i > 0 ? "-" + i : ""),
      };
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
        queue.push(q);
      } else {
        q.resolve(false);
      }
    });
  }

  if (queue.length > 0) {
    const timer = setTimeout(() => drainQueue(session), BATCH_INTERVAL_MS);
    timer.unref();
    queueTimers.set(session, timer);
  } else {
    const t = queueTimers.get(session);
    if (t) {
      clearTimeout(t);
      queueTimers.delete(session);
    }
  }
}

function enqueueMessage(session: CDP.Client, message: object): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let queue = messageQueues.get(session);
    if (!queue) {
      queue = [];
      messageQueues.set(session, queue);
    }

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

    if (!queueTimers.has(session)) {
      const timer = setTimeout(() => drainQueue(session), BATCH_INTERVAL_MS);
      timer.unref();
      queueTimers.set(session, timer);
    }
  });
}

export async function sendToExtension(session: CDP.Client, message: object): Promise<boolean> {
  try {
    return await enqueueMessage(session, message);
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

export const OVERLAY_HIDE_SELECTORS = [
  "#wt-shadow-host",
  "weavetab-host",
  "#Weavetab-root",
  "[data-wt-overlay]",
  "[data-Weavetab-overlay]",
  "#__Weavetab_cursor_host",
  "[data-wt-internal]",
  "[data-wt-ignore]",
  ".wt-bubble",
  "#__wt_ask_bridge",
  "#wt-debug-overlay",
  "#wt-main-container",
];

export async function hideWeaveTabOverlay(session: CDP.Client): Promise<void> {
  await session.Runtime.evaluate({
    expression: `(function(){
      var existing = document.getElementById('__wt_hide_overlay_styles');
      if (existing) return;
      var style = document.createElement('style');
      style.id = '__wt_hide_overlay_styles';
      style.textContent = ${JSON.stringify(OVERLAY_HIDE_SELECTORS.join(", ") + " { display: none !important; visibility: hidden !important; opacity: 0 !important; }")};
      var mount = document.head || document.documentElement;
      if (mount) mount.appendChild(style);
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

export const showWeaveTabOverlay = restoreWeaveTabOverlay;

export async function applySecretHardening(
  session: CDP.Client,
  objectId?: string,
  selector?: string
): Promise<void> {
  const hardeningScript = `function() {
    try {
      const el = this;
      if (!el) return;
      try { el.setAttribute('data-wt-secret', 'true'); } catch (_) {}

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

      try {
        Object.defineProperty(el, Symbol.iterator, {
          value: function* () { yield '[REDACTED]'; },
          configurable: true
        });
        Object.defineProperty(el, Symbol.toPrimitive, {
          value: function() { return '[REDACTED]'; },
          configurable: true
        });
        Object.defineProperty(el, 'toJSON', {
          value: function() { return '[REDACTED]'; },
          configurable: true
        });
      } catch(_) {}
    } catch (e) {}
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

export const MASK_SECRET_FIELDS_EXPR = `(function() {
  var secretRegex = /password|passcode|pin|passphrase|secret|token|auth.?key|access.?code|mot.?de.?passe|contrase[nñ]a|kennwort|senha/i;

  function queryAllDeep(root, matchFn, out) {
    if (!out) out = [];
    var elements = root.querySelectorAll('*');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (matchFn(el)) out.push(el);
      if (el.shadowRoot) {
        queryAllDeep(el.shadowRoot, matchFn, out);
      }
    }
    return out;
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

  var els = queryAllDeep(document, isSecretNode, []);
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.dataset.wtCapOrigStyle === undefined) {
      el.dataset.wtCapOrigStyle = el.getAttribute('style') || '';
    }
    el.style.setProperty('-webkit-text-security', 'disc', 'important');
    el.style.setProperty('color', 'transparent', 'important');
    el.style.setProperty('text-shadow', 'none', 'important');
  }
})()`;

export const RESTORE_SECRET_FIELDS_EXPR = `(function() {
  function queryAllDeep(root, out) {
    if (!out) out = [];
    var elements = root.querySelectorAll('*');
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (el.dataset && el.dataset.wtCapOrigStyle !== undefined) {
        out.push(el);
      }
      if (el.shadowRoot) {
        queryAllDeep(el.shadowRoot, out);
      }
    }
    return out;
  }

  var els = queryAllDeep(document, []);
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    var orig = el.dataset.wtCapOrigStyle;
    if (orig) {
      el.setAttribute('style', orig);
    } else {
      el.removeAttribute('style');
    }
    delete el.dataset.wtCapOrigStyle;
  }
})()`;

export async function maskSecretFieldsForCapture(session: CDP.Client): Promise<void> {
  await session.Runtime.evaluate({
    expression: MASK_SECRET_FIELDS_EXPR,
    returnByValue: false,
  }).catch(() => {});
}

export async function restoreSecretFieldsAfterCapture(session: CDP.Client): Promise<void> {
  await session.Runtime.evaluate({
    expression: RESTORE_SECRET_FIELDS_EXPR,
    returnByValue: false,
  }).catch(() => {});
}
