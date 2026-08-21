/**
 * Weavetab — cdp/extension.ts
 * Extension detection and health-check layer.
 * All extension-dependent tools should call requireExtension() before proceeding.
 * Weavetab by fy2ne
 */
import CDP from "chrome-remote-interface";

/**
 * Check whether the Weavetab extension is loaded in the current page.
 * Uses DOM markers instead of JS globals because content scripts run in
 * an ISOLATED world (MV3) — window.__Weavetab is invisible from MAIN world.
 */
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

/**
 * Throws a clear, actionable error if the extension is not loaded.
 */
export async function requireExtension(session: CDP.Client): Promise<void> {
  let loaded = await isExtensionLoaded(session);
  
  if (!loaded) {
    try {
      // Auto-recovery: if marker is missing, the page might be in a broken state.
      // Attempt a single reload before failing the tool call.
      await session.Page.reload({ ignoreCache: false });
      await new Promise(r => setTimeout(r, 2000)); // wait for content script injection
      loaded = await isExtensionLoaded(session);
    } catch { /* ignore reload errors */ }
  }

  if (!loaded) {
    throw new Error(
      "[!] Weavetab Extension not detected on this page. " +
      "Make sure the extension is installed (from ext-dist/) and the page has been loaded/refreshed. " +
      "Some tools require the extension for full functionality."
    );
  }
}

/**
 * Full health check — which extension features are available.
 */
export async function extensionHealth(session: CDP.Client): Promise<{
  loaded: boolean;
  version?: string;
  features: string[];
}> {
  try {
    // Use DOM markers + fallback JS checks via postMessage bridge
    const loaded = await isExtensionLoaded(session);
    const { result } = await session.Runtime.evaluate({
      expression: `(function() {
        const features = [];
        if (document.querySelector('weavetab-host') || document.getElementById('__Weavetab_cursor_host')) features.push('cursor');
        if (document.querySelector('[data-wt-internal]') || document.getElementById('wt-ui-styles')) features.push('styles');
        if (document.querySelector('.wt-bubble')) features.push('bubble');
        return JSON.stringify({
          loaded: ${loaded},
          features
        });
      })()`,
      returnByValue: true,
    });
    if (result?.value) {
      return JSON.parse(result.value as string);
    }
  } catch { /* ignore */ }
  return { loaded: false, features: [] };
}

/**
 * Suppress all visual overlays/borders the extension draws on interactive elements.
 * Call this before taking screenshots or when clean rendering is needed.
 * Default behavior for browser_map — overlays should only appear via browser_highlight.
 */
export async function suppressOverlays(session: CDP.Client): Promise<void> {
  try {
    await session.Runtime.evaluate({
      expression: `(function() {
        // Remove any existing Weavetab overlay elements
        document.querySelectorAll('[data-Weavetab-overlay]').forEach(el => el.remove());
        // Hide fallback visual elements
        var sr = document.getElementById('Weavetab-root');
        if (sr && sr.shadowRoot) {
          var els = sr.shadowRoot.querySelectorAll('#wt-fallback-cursor, #wt-fallback-hud, #wt-fallback-thought');
          els.forEach(function(el){ el.style.display = 'none'; });
        }
        // Post a message for the content script (isolated world)
        window.postMessage({ type: 'Weavetab_SUPPRESS_VISUALS', suppress: true }, '*');
      })()`,
      returnByValue: false,
    });
  } catch { /* non-fatal */ }
}

/**
 * Re-enable visual overlays for debugging purposes.
 * Only call this if user explicitly passes show_overlays: true to browser_map.
 */
export async function restoreOverlays(session: CDP.Client): Promise<void> {
  try {
    await session.Runtime.evaluate({
      expression: `(function() {
        // Restore fallback visual elements
        var sr = document.getElementById('Weavetab-root');
        if (sr && sr.shadowRoot) {
          var els = sr.shadowRoot.querySelectorAll('#wt-fallback-cursor, #wt-fallback-hud, #wt-fallback-thought');
          els.forEach(function(el){ el.style.display = ''; });
        }
        window.postMessage({ type: 'Weavetab_SUPPRESS_VISUALS', suppress: false }, '*');
      })()`,
      returnByValue: false,
    });
  } catch { /* non-fatal */ }
}
