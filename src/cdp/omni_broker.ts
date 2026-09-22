/**
 * Weavetab — cdp/omni_broker.ts
 * Omni-Context Execution Broker
 * Handles Target.setAutoAttach to run code in cross-origin iframes.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";

/**
 * Stores active iframe CDP sessions mapped by their frame targetId.
 * Keyed by the parent page's targetId to ensure isolation.
 */
const omniSessions = new Map<string, Map<string, CDP.Client>>();

/**
 * Initializes the Omni-Context Broker for a parent page session.
 * Automatically attaches to all OOPIFs (Out-of-Process Iframes) and caches their CDP clients.
 */
export async function initOmniBroker(parentSession: CDP.Client, parentTargetId: string, port: number): Promise<void> {
  if (!omniSessions.has(parentTargetId)) {
    omniSessions.set(parentTargetId, new Map());
  }

  parentSession.Target.on("attachedToTarget", async (event) => {
    const { targetInfo } = event;
    if (targetInfo && targetInfo.targetId !== parentTargetId && (targetInfo.type === 'iframe' || targetInfo.type === 'webview' || targetInfo.type === 'page' || targetInfo.type === 'app')) {
      try {
        // Connect a flat session to the child iframe/webview target
        const childSession = await CDP({ host: "127.0.0.1", port, target: targetInfo.targetId });
        await Promise.all([
          childSession.Runtime.enable().catch(() => {}),
          childSession.DOM.enable().catch(() => {}),
          childSession.Page.enable().catch(() => {})
        ]);
        omniSessions.get(parentTargetId)!.set(targetInfo.targetId, childSession);
      } catch (e) {
        // Fallback or ignore
      }
    }
  });

  // Handle detachedFromTarget so iframe CDP sessions are closed when iframes
  // navigate away or are removed from the DOM. Without this, WebSocket connections
  // leak on pages with dynamic iframes (e.g. news sites with ad iframes).
  parentSession.Target.on("detachedFromTarget", async (event) => {
    const { targetId } = event;
    const iframeMap = omniSessions.get(parentTargetId);
    if (iframeMap && targetId && iframeMap.has(targetId)) {
      try { iframeMap.get(targetId)!.close(); } catch { }
      iframeMap.delete(targetId);
    }
  });

  try {
    await parentSession.Target.setAutoAttach({
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true, // Use flat sessions (sessionId)
    });
  } catch (e) {
    console.warn("[OmniBroker] Failed to setAutoAttach", e);
  }
}

/**
 * Executes a CDP command across all known iframe contexts if it fails in the top-level context.
 */
export async function omniEvaluate(
  parentSession: CDP.Client,
  parentTargetId: string,
  expression: string,
  returnByValue = true
): Promise<any> {
  // Try parent first
  const { result } = await parentSession.Runtime.evaluate({
    expression,
    returnByValue
  });

  if (result && !result.subtype && result.value !== null && result.value !== undefined) {
    const parsed = typeof result.value === 'string' ? parseJSON(result.value) : result.value;
    if (parsed && (parsed.exists === false || parsed.ok === false || parsed === false)) {
      // Proceed to try iframes
    } else {
      return result.value;
    }
  }

  // Fallback to all known iframes
  const iframeMap = omniSessions.get(parentTargetId);
  if (iframeMap) {
    for (const iframeSession of iframeMap.values()) {
      try {
        const { result: iframeResult } = await iframeSession.Runtime.evaluate({
          expression,
          returnByValue
        });

        if (iframeResult && iframeResult.value) {
          const parsed = typeof iframeResult.value === 'string' ? parseJSON(iframeResult.value) : iframeResult.value;
          if (parsed && parsed.exists !== false && parsed.ok !== false) {
            return iframeResult.value;
          }
        }
      } catch (e) { }
    }
  }

  return result?.value; // Return the failed parent result if no iframe succeeds
}

function parseJSON(str: string) {
  try { return JSON.parse(str); } catch { return str; }
}

export function getOmniSessions(parentTargetId: string): Map<string, CDP.Client> | undefined {
  return omniSessions.get(parentTargetId);
}

export function cleanupOmniBroker(parentTargetId: string) {
  const iframeMap = omniSessions.get(parentTargetId);
  if (iframeMap) {
    for (const session of iframeMap.values()) {
      try { session.close(); } catch { }
    }
    omniSessions.delete(parentTargetId);
  }
}

