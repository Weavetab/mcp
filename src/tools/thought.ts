// src/tools/thought.ts
// browser_thought — agent-to-user communication via green thought bubbles
// Merged: browser_feedback (one-way) + legacy browser_ask (two-way with input) into browser_thoughts

import CDP from "chrome-remote-interface";
import { logAction } from "../audit/logger.js";
import { sendToExtension } from "../cdp/helpers.js";

function sleep(ms: number) {
  return new Promise(r => setTimeout(r, ms));
}

export interface ThoughtOptions {
  action: "feedback" | "question";
  message: string;
  anchor?: string;
  style?: "observation" | "decision" | "warning" | "question";
  input?: "sentence" | "paragraph";
  timeout?: number;
}

export interface ThoughtResult {
  success: boolean;
  response?: string;
  timeout?: boolean;
  cancelled?: boolean;
  status?: "answered" | "cancelled" | "timeout";
  error?: string;
}

export async function browserThought(
  session: CDP.Client,
  args: ThoughtOptions
): Promise<ThoughtResult> {
  const { action, message, input, timeout, anchor, style } = args;

  logAction("browser_thought", action, message);

  if (action === "feedback") {
    // Forward thought event to extension
    await sendToExtension(session, {
      type: 'WT_THOUGHT',
      text: message,
      kind: 'thought',
      anchor,
      style: style || 'observation',
      action: 'feedback',
    }).catch(() => {});

    return { success: true };
  }

  if (action === "question") {
    const QUESTION_TIMEOUT_MS = Math.min((timeout || 20), 20) * 1000;

    await sendToExtension(session, {
      type: 'WT_THOUGHT',
      text: message,
      kind: 'question',
      anchor,
      style: style || 'question',
      action: 'question',
      input: input || "sentence",
      timeout: Math.min((timeout || 20), 20),
    }).catch(() => {});

    const start = Date.now();
    while (Date.now() - start < QUESTION_TIMEOUT_MS + 5000) {
      await sleep(500);
      try {
        const { result } = await session.Runtime.evaluate({
          expression: `(() => { try {
            var el = document.getElementById('__wt_ask_bridge');
            if (!el || el.dataset.status === 'pending') return null;
            return JSON.stringify({ status: el.dataset.status, result: el.dataset.result });
          } catch(e) { return null; } })()`,
          returnByValue: true,
        });
        if (result?.value) {
          const data = JSON.parse(result.value as string);
            if (data.status === 'submitted') {
              logAction("browser_thought", "answered", data.result);
              await session.Runtime.evaluate({
                expression: `(function() {
                  var el = document.getElementById('__wt_ask_bridge');
                  if (el) el.remove();
                })()`
              }).catch(() => {});
              return { success: true, response: data.result, status: "answered" };
            }
            if (data.status === 'cancelled') {
              logAction("browser_thought", "cancelled", "");
              return { success: true, response: "", timeout: true, cancelled: true, status: "cancelled" };
            }
            if (data.status === 'timeout') {
              logAction("browser_thought", "timeout", "");
              return { success: true, response: "", timeout: true, status: "timeout" };
            }
        }
      } catch {
        // polling error — retry
      }
    }

    logAction("browser_thought", "timeout", "");
    return { success: true, response: "", timeout: true, status: "timeout" };
  }

  return { success: false, error: `Unknown action: ${action}` };
}
