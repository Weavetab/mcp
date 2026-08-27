/**
 * Weavetab — tools/clipboard.ts
 * browser_clipboard: Read and write text + images to the system/browser clipboard.
 * Uses synthetic mouse click to grant user activation before clipboard API calls.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";
import type { Config } from "../config/loader.js";
import { ghostClick } from "../overlay/ghost.js";

export interface ClipboardOptions {
  action: "read" | "write";
  /** Text content to write (required for text write, optional if dataUrl is provided) */
  text?: string;
  /** Base64 data URL for image write (e.g. "data:image/png;base64,iVBOR...") */
  dataUrl?: string;
  /** MIME type override (auto-detected from dataUrl by default) */
  mimeType?: string;
  /**
   * When true, skips the (5,5) user-activation click before clipboard write.
   * Set this when the calling context already has input focus (e.g. browser_type)
   * to prevent blurring the focused field before Ctrl+V.
   */
  skipActivation?: boolean;
}

export async function browserClipboard(
  session: CDP.Client,
  options: ClipboardOptions,
  _config: Config
): Promise<{ success: boolean; text?: string; dataUrl?: string; message: string }> {
  const { action, text, dataUrl, mimeType } = options;

  // ── Dispatch a synthetic click to grant transient user activation ──
  async function grantActivation() {
    try {
      await ghostClick(session, 5, 5);
      await session.Input.dispatchMouseEvent({ type: "mouseReleased", x: 5, y: 5, button: "left", clickCount: 1 });
    } catch {
      // Non-critical — proceed anyway
    }
  }

  // Detect non-secure context (file://, http://) up front. The Clipboard API is
  // undefined there, and raw CDP ops can hang or throw -32001. Surface a typed
  // error instead.
  async function isSecureContext(): Promise<boolean> {
    try {
      const { result } = await session.Runtime.evaluate({
        expression: "window.isSecureContext === true",
        returnByValue: true,
        timeout: 1500,
      });
      return result?.value === true;
    } catch {
      return false;
    }
  }

  if (action === "write") {
    const hasText = text !== undefined;
    const hasImage = dataUrl !== undefined;
    if (!hasText && !hasImage) {
      throw new Error("Provide 'text' and/or 'dataUrl' for write action");
    }

    // ── Grant user activation only for standalone clipboard writes ───────────
    // When called from browser_type, the input field is already focused.
    // Clicking (5,5) here would blur the field before Ctrl+V, causing the
    // phantom-click + wipe + write-to-BODY issue.
    if (!options.skipActivation) {
      await grantActivation();
    }

    const secureCtx = await isSecureContext();

    if (hasImage) {
      if (!secureCtx) {
        throw new Error("browser_clipboard: image write requires a secure context (https or chrome://). Current page is non-secure (file:// or http://).");
      }
      const mime = mimeType || (dataUrl!.includes(';') ? dataUrl!.split(';')[0].split(':')[1] : "image/png");
      const res = await session.Runtime.evaluate({
        expression: `(async function() {
          try {
            const resp = await fetch(${JSON.stringify(dataUrl)});
            const blob = await resp.blob();
            await navigator.clipboard.write([
              new ClipboardItem({ ${JSON.stringify(mime)}: blob })
            ]);
            return "ok";
          } catch(e) {
            return "ERR:" + e.message;
          }
        })()`,
        awaitPromise: true,
        returnByValue: true
      });
      const val = res.result?.value;
      if (val === "ok") {
        return { success: true, message: hasText ? "Text and image copied to clipboard" : "Image copied to clipboard" };
      }
      throw new Error("Failed to write image to clipboard: " + (val || "unknown"));
    }

    // Text-only write
    if (hasText && !hasImage) {
      try {
        const clipboardy = (await import("clipboardy")).default;
        await clipboardy.write(text!);
        return { success: true, message: "Copied to clipboard" };
      } catch { /* fallback to browser API */ }

      const res = await session.Runtime.evaluate({
        expression: `(async function() {
          try {
            ${secureCtx ? `await navigator.clipboard.writeText(${JSON.stringify(text)});` : `throw new Error('non-secure');`}
            return true;
          } catch(e) {
            return false;
          }
        })()`,
        awaitPromise: true,
        returnByValue: true
      });

      if (res.result?.value === true) {
        return { success: true, message: "Copied to clipboard" };
      }
      return { success: true, message: "Copied to clipboard" };
    }
  }

  // ── Read action ──────────────────────────────────────────────────
  // 4-layer clipboard read strategy:
  // Layer 1: CDP mouse click on body + page script click() for user activation
  // Layer 2: navigator.clipboard.read() API
  // Layer 3: Ctrl+V via trusted CDP key event → hidden textarea
  // Layer 4: document.execCommand('paste') fallback
  async function grantUserActivation() {
    try {
      const { result: vp } = await session.Runtime.evaluate({
        expression: '({w: window.innerWidth, h: window.innerHeight})',
        returnByValue: true
      });
      const cx = Math.floor((vp?.value?.w || 800) / 2);
      const cy = Math.floor((vp?.value?.h || 600) / 2);
      await ghostClick(session, cx, cy);
      await session.Input.dispatchMouseEvent({ type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
      await session.Runtime.evaluate({ expression: 'document.body.click()' }).catch(() => {});
    } catch { /* non-critical */ }
  }

  async function readViaCdpPaste(): Promise<string | null> {
    const { result } = await session.Runtime.evaluate({
      expression: `(function() {
        try {
          var ta = document.createElement('textarea');
          ta.style.cssText = 'position:fixed;top:-999px;left:-999px;opacity:0;width:1px;height:1px';
          document.body.appendChild(ta);
          ta.focus();
          ta.select();
          return true;
        } catch(e) { return false; }
      })()`,
      returnByValue: true
    });
    if (result?.value !== true) return null;
    await session.Input.dispatchKeyEvent({ type: "rawKeyDown", key: "v", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2 });
    await session.Input.dispatchKeyEvent({ type: "keyUp", key: "v", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 2 });
    await new Promise(r => setTimeout(r, 100));
    const { result: valRes } = await session.Runtime.evaluate({
      expression: `(function() {
        var ta = document.querySelector('textarea[style*="top:-999px"]');
        if (!ta) return null;
        var v = ta.value;
        ta.remove();
        return v || null;
      })()`,
      returnByValue: true
    });
    return (valRes?.value as string) || null;
  }

  // Layer 0: Direct OS system clipboard read via clipboardy
  try {
    const clipboardy = (await import("clipboardy")).default;
    const sysText = await clipboardy.read();
    if (sysText && sysText.trim().length > 0) {
      return { success: true, text: sysText, message: "Read from clipboard" };
    }
  } catch {}

  await grantUserActivation();

  const secureCtx = await isSecureContext();

  const originRes = await session.Runtime.evaluate({ expression: "window.location.origin" }).catch(() => null);
  if (originRes && originRes.result.value && secureCtx) {
    await session.Browser.grantPermissions({
      origin: originRes.result.value,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"]
    }).catch(() => {});
  }

  const READ_TIMEOUT_MS = 2000;
  let readResult: string | null = null;

  // Layer 1+2: Try clipboard API with user activation (secure contexts only)
  const apiRead = async (): Promise<string | null> => {
    if (!secureCtx) return null;
    const res = await session.Runtime.evaluate({
      expression: `(async function() {
        try {
          if (typeof ClipboardItem !== 'undefined') {
            var items = await navigator.clipboard.read();
            var textVal = null, dataUrlVal = null;
            for (var i = 0; i < items.length; i++) {
              var item = items[i];
              var types = item.types;
              for (var j = 0; j < types.length; j++) {
                var type = types[j];
                var blob = await item.getType(type);
                if (type.indexOf('text/') === 0) {
                  textVal = await blob.text();
                } else if (type.indexOf('image/') === 0) {
                  dataUrlVal = await new Promise(function(rsv) {
                    var r = new FileReader();
                    r.onload = function() { rsv(r.result); };
                    r.readAsDataURL(blob);
                  });
                }
              }
            }
            if (textVal || dataUrlVal) return JSON.stringify({ text: textVal, dataUrl: dataUrlVal });
          }
          var t = await navigator.clipboard.readText();
          if (t) return JSON.stringify({ text: t });
          return null;
        } catch(e) {
          return 'ERR:' + e.message;
        }
      })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: READ_TIMEOUT_MS
    });
    if (res.exceptionDetails) return null;
    const raw = res.result?.value as string;
    if (!raw || raw.startsWith('ERR:')) return null;
    return raw;
  };

  try {
    readResult = await Promise.race([
      apiRead(),
      new Promise<null>(r => setTimeout(() => r(null), READ_TIMEOUT_MS))
    ]);
  } catch (e) {
    // If API read fails, fall through to CDP paste method
    readResult = null;
  }

  // Layer 3: Ctrl+V via CDP key dispatch (trusted event — no user activation needed)
  if (!readResult) {
    try {
      const pasteVal = await Promise.race([
        readViaCdpPaste(),
        new Promise<string | null>(r => setTimeout(() => r(null), 1000))
      ]);
      if (pasteVal) {
        readResult = JSON.stringify({ text: pasteVal });
      }
    } catch {
      readResult = null;
    }
  }

  // Layer 4: execCommand fallback
  if (!readResult) {
    try {
      const evalResult = await Promise.race([
        session.Runtime.evaluate({
          expression: `(function() {
            try {
              var ta = document.createElement('textarea');
              ta.style.cssText = 'position:fixed;top:-999px;left:-999px;opacity:0';
              document.body.appendChild(ta);
              ta.focus();
              var ok = document.execCommand('paste');
              var v = ta.value;
              ta.remove();
              return ok && v ? JSON.stringify({ text: v }) : null;
            } catch(e) { return null; }
          })()`,
          returnByValue: true
        }),
        new Promise(r => setTimeout(() => r({ result: { value: null } }), 500))
      ]);
      const result = evalResult as { result?: { value?: string | null } };
      readResult = result?.result?.value as string || null;
    } catch {
      readResult = null;
    }
  }

  if (!readResult) {
    if (!secureCtx) {
      return { success: false, message: "Clipboard is empty or inaccessible. Current page is a non-secure context (file:// or http://) where the Clipboard API is unavailable; trusted CDP paste also returned nothing. Navigate to an https page and retry." };
    }
    return { success: true, message: "Clipboard is empty or inaccessible (browser may require user permission)" };
  }

  try {
    const obj = JSON.parse(readResult);
    return {
      success: true,
      text: obj.text || undefined,
      dataUrl: obj.dataUrl || undefined,
      message: obj.text && obj.dataUrl ? "Read text and image from clipboard" : obj.dataUrl ? "Read image from clipboard" : "Read from clipboard"
    };
  } catch {
    return { success: true, text: readResult, message: "Read from clipboard" };
  }
}
