import CDP from "chrome-remote-interface";
import { logDebug } from "../audit/logger.js";

const omniSessions = new Map<string, Map<string, CDP.Client>>();
const sessionToTarget = new Map<string, Map<string, string>>();

export async function initOmniBroker(parentSession: CDP.Client, parentTargetId: string, port: number): Promise<void> {
  if (!omniSessions.has(parentTargetId)) {
    omniSessions.set(parentTargetId, new Map());
  }
  if (!sessionToTarget.has(parentTargetId)) {
    sessionToTarget.set(parentTargetId, new Map());
  }

  parentSession.Target.on("attachedToTarget", async (event) => {
    const { targetInfo, sessionId } = event;
    if (
      targetInfo &&
      targetInfo.targetId !== parentTargetId &&
      (targetInfo.type === "iframe" || targetInfo.type === "webview")
    ) {
      if (sessionId) {
        sessionToTarget.get(parentTargetId)?.set(sessionId, targetInfo.targetId);
      }
      try {
        const childSession = await CDP({ host: "127.0.0.1", port, target: targetInfo.targetId });
        const parentMap = omniSessions.get(parentTargetId);
        if (!parentMap) {
          try { await childSession.close(); } catch {}
          return;
        }
        (childSession as any).on("error", () => {});
        (childSession as any).on("close", () => {
          omniSessions.get(parentTargetId)?.delete(targetInfo.targetId);
        });

        await Promise.all([
          childSession.Runtime.enable().catch(() => {}),
          childSession.DOM.enable().catch(() => {}),
          childSession.Page.enable().catch(() => {})
        ]);

        const currentMap = omniSessions.get(parentTargetId);
        if (!currentMap) {
          try { await childSession.close(); } catch {}
          return;
        }
        const prev = currentMap.get(targetInfo.targetId);
        if (prev && prev !== childSession) {
          try { prev.close(); } catch {}
        }
        currentMap.set(targetInfo.targetId, childSession);
      } catch {
        // ignore child target connect error
      }
    }
  });

  parentSession.Target.on("detachedFromTarget", async (event) => {
    const { targetId, sessionId } = event;
    const iframeMap = omniSessions.get(parentTargetId);
    const sidMap = sessionToTarget.get(parentTargetId);

    const resolvedTargetId = targetId || (sessionId && sidMap ? sidMap.get(sessionId) : undefined);
    if (sessionId && sidMap) {
      sidMap.delete(sessionId);
    }
    if (iframeMap && resolvedTargetId && iframeMap.has(resolvedTargetId)) {
      try { iframeMap.get(resolvedTargetId)!.close(); } catch {}
      iframeMap.delete(resolvedTargetId);
    }
  });

  try {
    await parentSession.Target.setAutoAttach({
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
  } catch (e) {
    logDebug(`[OmniBroker] Failed to setAutoAttach: ${e}`);
  }
}

export async function omniEvaluate(
  parentSession: CDP.Client,
  parentTargetId: string,
  expression: string,
  returnByValue = true
): Promise<any> {
  const { result } = await parentSession.Runtime.evaluate({
    expression,
    returnByValue
  });

  if (result && !result.subtype && result.value !== null && result.value !== undefined) {
    const parsed = typeof result.value === "string" ? parseJSON(result.value) : result.value;
    if (parsed === false || (parsed && (parsed.exists === false || parsed.ok === false))) {
      // proceed to try iframes
    } else {
      return result.value;
    }
  }

  const iframeMap = omniSessions.get(parentTargetId);
  if (iframeMap) {
    for (const iframeSession of iframeMap.values()) {
      try {
        const { result: iframeResult } = await iframeSession.Runtime.evaluate({
          expression,
          returnByValue
        });

        if (iframeResult && iframeResult.value !== null && iframeResult.value !== undefined) {
          const parsed = typeof iframeResult.value === "string" ? parseJSON(iframeResult.value) : iframeResult.value;
          if (parsed !== false && parsed && parsed.exists !== false && parsed.ok !== false) {
            return iframeResult.value;
          }
        }
      } catch {}
    }
  }

  return result?.value;
}

function parseJSON(str: string) {
  try { return JSON.parse(str); } catch { return str; }
}

export function getOmniSessions(parentTargetId: string): Map<string, CDP.Client> | undefined {
  return omniSessions.get(parentTargetId);
}

export function cleanupOmniBroker(parentTargetId: string): void {
  const iframeMap = omniSessions.get(parentTargetId);
  if (iframeMap) {
    for (const session of iframeMap.values()) {
      try { session.close(); } catch {}
    }
    omniSessions.delete(parentTargetId);
  }
  sessionToTarget.delete(parentTargetId);
}
