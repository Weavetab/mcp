import CDP from "chrome-remote-interface";
import { hideWeaveTabOverlay, showWeaveTabOverlay } from "./helpers.js";

export async function isExtensionLoaded(session: CDP.Client): Promise<boolean> {
  try {
    const { result } = await session.Runtime.evaluate({
      expression: `!!(
        document.getElementById('wt-extension-marker') ||
        document.querySelector('weavetab-host') ||
        document.querySelector('[data-wt-internal]') ||
        document.getElementById('__Weavetab_cursor_host') ||
        document.getElementById('wt-ui-styles')
      )`,
      returnByValue: true,
    });
    return result?.value === true;
  } catch {
    return false;
  }
}

export async function suppressOverlays(session: CDP.Client): Promise<void> {
  try {
    await hideWeaveTabOverlay(session);
    await session.Runtime.evaluate({
      expression: `window.postMessage({ type: 'Weavetab_SUPPRESS_VISUALS', suppress: true }, '*');`,
      returnByValue: false,
    });
  } catch { /* non-fatal */ }
}

export async function restoreOverlays(session: CDP.Client): Promise<void> {
  try {
    await showWeaveTabOverlay(session);
    await session.Runtime.evaluate({
      expression: `window.postMessage({ type: 'Weavetab_SUPPRESS_VISUALS', suppress: false }, '*');`,
      returnByValue: false,
    });
  } catch { /* non-fatal */ }
}
