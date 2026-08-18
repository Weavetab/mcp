import { logDebug } from "../audit/logger.js";
import CDP from "chrome-remote-interface";

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
      //  - #wt-plan-dashboard   : mission plan dashboard
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
        '#wt-plan-dashboard',
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
