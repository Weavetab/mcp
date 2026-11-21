import CDP from "chrome-remote-interface";

export type WaitCondition = "navigation" | "network_idle" | "dom_stable";

export async function waitForNetworkIdle(
  session: CDP.Client,
  idleThresholdMs = 300,
  timeout = 5000
): Promise<void> {
  const { Network } = session;
  await Network.enable();

  return new Promise<void>((resolve) => {
    let idleTimer: NodeJS.Timeout | undefined;
    let done = false;
    const unsubs: Array<() => void> = [];

    const cleanup = () => {
      if (done) return;
      done = true;
      if (idleTimer) clearTimeout(idleTimer);
      clearTimeout(deadline);
      for (const unsub of unsubs) {
        try {
          unsub();
        } catch {}
      }
      unsubs.length = 0;
      resolve();
    };

    const deadline = setTimeout(cleanup, timeout);

    const reset = () => {
      if (done) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(cleanup, idleThresholdMs);
    };

    for (const ev of ["requestWillBeSent", "loadingFinished", "loadingFailed"] as const) {
      const ret = (session.Network as any).on(ev, reset);
      if (typeof ret === "function") {
        unsubs.push(ret);
      } else if (typeof (session.Network as any).removeListener === "function") {
        unsubs.push(() => (session.Network as any).removeListener(ev, reset));
      }
    }

    reset();
  });
}
