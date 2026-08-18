/**
 * Weavetab — sensors/wait.ts
 * Network idle detection used internally by navigate and burst — never exposed as an MCP tool.
 * Weavetab by fy2ne
 */

import CDP from "chrome-remote-interface";

export type WaitCondition = "navigation" | "network_idle" | "dom_stable";

/**
 * Wait for the network to be idle (no requests for 500ms).
 * Used internally by navigate and burst — never exposed as a tool.
 */
export async function waitForNetworkIdle(
  session: CDP.Client,
  idleThresholdMs = 300,
  timeout = 5000
): Promise<void> {
  const { Network } = session;
  await Network.enable();

  return new Promise<void>((resolve) => {
    let idleTimer: NodeJS.Timeout;
    let done = false;
    const deadline = setTimeout(() => { done = true; resolve(); }, timeout);

    const cleanup = () => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer);
      clearTimeout(deadline);
      // Remove the Network listeners on the object they were registered on
      // (session.Network), otherwise every waitForNetworkIdle call leaks 3 listeners.
      try {
        (session.Network as any).removeListener('requestWillBeSent', reset);
        (session.Network as any).removeListener('loadingFinished', reset);
        (session.Network as any).removeListener('loadingFailed', reset);
      } catch { /* ignore */ }
      resolve();
    };

    const reset = () => {
      if (done) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(cleanup, idleThresholdMs);
    };

    session.Network.on("requestWillBeSent", reset);
    session.Network.on("loadingFinished", reset);
    session.Network.on("loadingFailed", reset);
    reset();
  });
}
