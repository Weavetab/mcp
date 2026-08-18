/**
 * Weavetab — tools/dialog.ts
 * Auto-handles JavaScript alert/confirm/prompt dialogs via CDP Page API.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";
import { logAction } from "../audit/logger.js";

export interface DialogResult {
  success: true;
  dialog_type: string;
  message: string;
  accepted: boolean;
}

// Store the last dialog event data per session using a WeakMap. This survives
// across initDialogHandler → browserDialog calls without leaking memory
// (entries are GC'd when the session is released).
const dialogState = new WeakMap<CDP.Client, { type: string; message: string; defaultPrompt?: string; autoDismiss?: boolean; timeoutId?: NodeJS.Timeout }>();

export function hasOpenDialog(session: CDP.Client): boolean {
  const state = dialogState.get(session);
  return state != null && !state.autoDismiss;
}

/** Register the auto-dismiss handler for the given CDP session. */
export function initDialogHandler(session: CDP.Client): void {
  session.Page.on("javascriptDialogOpening", async (event) => {
    const { type, message, defaultPrompt } = event;

    // Store dialog metadata WITHOUT auto-dismissing so browserDialog can read
    // the type and handle it appropriately. This is the only point where CDP
    // exposes the real type.
    dialogState.set(session, { type, message, defaultPrompt, autoDismiss: false });

    logAction("browser_dialog", type, `dialog detected: "${message}"`);

    // Inject a visual toast so the user knows we detected it
    const toastScript = `
      (function() {
        if (document.getElementById('wt-dialog-toast')) return;
        const toast = document.createElement("div");
        toast.id = 'wt-dialog-toast';
        toast.style.cssText = "position:fixed;bottom:20px;right:20px;background:#f59e0b;color:white;padding:12px 24px;border-radius:8px;font-family:sans-serif;font-weight:600;z-index:2147483647;box-shadow:0 4px 12px rgba(0,0,0,0.3);animation:fadein 0.3s, fadeout 0.3s 2.5s forwards;";
        toast.textContent = "${type} detected: ${message.substring(0, 50).replace(/"/g, '\\"')}";
        const style = document.createElement("style");
        style.textContent = "@keyframes fadein { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } } @keyframes fadeout { from { opacity: 1; } to { opacity: 0; } }";
        document.head.appendChild(style);
        document.documentElement.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
      })();
    `;
    session.Runtime.evaluate({ expression: toastScript }).catch(() => {});

    // For security-critical dialogs (like extension removal), auto-dismiss to prevent accidental acceptance
    if (message.toLowerCase().includes("extension") || message.toLowerCase().includes("developer mode")) {
      try {
        await session.Page.handleJavaScriptDialog({ accept: false });
        dialogState.set(session, { type, message, defaultPrompt, autoDismiss: true });
        logAction("browser_dialog", type, `auto-dismissed security dialog: "${message}"`);
      } catch {
        // Dialog may have already closed
      }
    } else {
      // For normal dialogs, leave them open for 5 seconds so browserDialog can handle them with the correct type
      // After timeout, auto-dismiss to prevent blocking
      const timeoutId = setTimeout(async () => {
        const current = dialogState.get(session);
        if (current && !current.autoDismiss) {
          try {
            await session.Page.handleJavaScriptDialog({ accept: false });
            dialogState.set(session, { type: current.type, message: current.message, defaultPrompt: current.defaultPrompt, autoDismiss: true });
            logAction("browser_dialog", current.type, `auto-dismissed after timeout: "${current.message}"`);
          } catch {
            // Dialog may have already been handled
          }
        }
      }, 5000);
      const current = dialogState.get(session);
      if (current) {
        current.timeoutId = timeoutId;
      }
    }
  });
}

/**
 * Manually trigger dialog handling — call this if the agent suspects
 * a dialog is pending that blocked previous tool calls.
 */
export interface DialogOptions {
  action: "accept" | "dismiss";
  promptText?: string;
}

export async function browserDialog(
  session: CDP.Client,
  options: DialogOptions
): Promise<DialogResult> {
  const { action, promptText } = options;

  // Read stored dialog metadata before handling. If promptText was provided but
  // the dialog type is 'prompt', pass it through so prompt injection works.
  const stored = dialogState.get(session) || null;

  // Clear the auto-dismiss timer immediately when browserDialog is called
  if (stored?.timeoutId) {
    clearTimeout(stored.timeoutId);
  }

  // Attempt to handle any currently open dialog
  try {
    await session.Page.handleJavaScriptDialog({
      accept: action === "accept",
      promptText: action === "accept"
        ? (promptText !== undefined ? promptText : (stored?.type === "prompt" ? (stored?.defaultPrompt ?? "") : undefined))
        : undefined,
    });
    
    // Mark as handled so the timeout handler doesn't try to dismiss it
    if (stored) {
      dialogState.set(session, { ...stored, autoDismiss: true });
    }
    
    // Clean up after a short delay
    setTimeout(() => dialogState.delete(session), 100);
  } catch (e) {
    // No dialog was open or it was already handled
    dialogState.delete(session);
  }

  logAction("browser_dialog", "manual", `attempted to ${action} pending dialog`);

  return {
    success: true,
    dialog_type: stored?.type || "unknown",
    message: stored?.message || `Dialog ${action}ed (or no dialog was open)`,
    accepted: action === "accept",
  };
}
