import CDP from "chrome-remote-interface";

export interface PollOptions {
  timeout: number;
  interval: number;
}

export async function pollUntil(
  predicate: () => Promise<boolean>,
  opts: PollOptions
): Promise<void> {
  const deadline = Date.now() + opts.timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(opts.interval);
  }
  throw new Error(`pollUntil: timed out after ${opts.timeout}ms`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function waitForDOMStable(
  session: CDP.Client,
  quietPeriod = 50,
  timeout = 800,
  fast = false
): Promise<void> {
  if (fast) return;

  await (session.Runtime.evaluate as any)({
    expression: `(function(quiet, maxWait) {
      return new Promise((resolve) => {
        const root = document.body || document.documentElement;
        if (!root) { resolve(true); return; }
        let timer;
        let maxTimer;
        let finished = false;
        const obs = new MutationObserver(() => {
          if (finished) return;
          clearTimeout(timer);
          timer = setTimeout(done, quiet);
        });
        function done() {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          clearTimeout(maxTimer);
          obs.disconnect();
          resolve(true);
        }
        obs.observe(root, { childList: true, subtree: true, attributes: true });
        timer = setTimeout(done, quiet);
        maxTimer = setTimeout(done, maxWait);
      });
    })(${quietPeriod}, ${timeout})`,
    awaitPromise: true,
    returnByValue: true,
    timeout: timeout + 500,
  }).catch(() => {});
}

export async function awaitNavigation(
  session: CDP.Client,
  timeout = 6000
): Promise<void> {
  const startTime = Date.now();
  const initialEval = await session.Runtime.evaluate({
    expression: `({ url: location.href, state: document.readyState })`,
    returnByValue: true,
  }).catch(() => null);
  const initialUrl = initialEval?.result?.value?.url;

  const unsubs: Array<() => void> = [];
  let navDetected = initialEval?.result?.value?.state === "loading";

  const cleanup = () => {
    for (const u of unsubs) {
      try {
        u();
      } catch {}
    }
    unsubs.length = 0;
  };

  try {
    await new Promise<void>((resolve) => {
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(commitTimer);
        cleanup();
        resolve();
      };

      const page: any = session.Page;
      if (page) {
        const onFrameNav = (params: any) => {
          if (!params?.frame?.parentId) {
            navDetected = true;
            done();
          }
        };
        const onLoad = () => {
          navDetected = true;
          done();
        };

        for (const [ev, fn] of [
          ["frameNavigated", onFrameNav],
          ["loadEventFired", onLoad],
        ] as const) {
          const ret =
            typeof page.on === "function"
              ? page.on(ev, fn)
              : typeof page[ev] === "function"
              ? page[ev](fn)
              : undefined;
          if (typeof ret === "function") {
            unsubs.push(ret);
          } else if (typeof page.removeListener === "function") {
            unsubs.push(() => page.removeListener(ev, fn));
          }
        }
      }

      if (navDetected) {
        done();
        return;
      }

      const commitWaitMs = Math.min(timeout, 250);
      const commitTimer = setTimeout(done, commitWaitMs);
    });

    const remaining = Math.max(100, timeout - (Date.now() - startTime));
    await pollUntil(
      async () => {
        const { result } = await session.Runtime.evaluate({
          expression: `({ url: location.href, state: document.readyState })`,
          returnByValue: true,
        }).catch(() => ({ result: { value: { url: initialUrl, state: "loading" } } }));
        const val = result?.value;
        if (val?.url && initialUrl && val.url !== initialUrl) {
          navDetected = true;
        }
        return val?.state === "complete" || val?.state === "interactive";
      },
      { timeout: remaining, interval: 30 }
    ).catch(() => {});
  } finally {
    cleanup();
  }

  await sleep(40);
}
