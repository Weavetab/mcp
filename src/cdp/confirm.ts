import CDP from "chrome-remote-interface";
import { waitForDOMStable } from "../sensors/guard.js";
import { logDebug } from "../audit/logger.js";

export interface ConfirmResult {
  applied: boolean;
  before: Record<string, string>;
  after: Record<string, string>;
  attempts: number;
  settleMs: number;
  confidence: number;
  degraded?: boolean;
}

export interface ConfirmOptions {
  settleMs?: number;
  maxAttempts?: number;
  retryIncrementMs?: number;
  requireConfirmation?: boolean;
  minConfidence?: number;
}

function shallowEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => a[k] === b[k]);
}

export function calculateConfidence(settleMs: number, attempts: number, maxAttempts: number): number {
  let confidence = 1.0;
  const safeMax = Math.max(1, maxAttempts);
  const safeSettle = Number.isFinite(settleMs) ? settleMs : 500;

  const attemptPenalty = ((Math.max(1, attempts) - 1) / safeMax) * 0.3;
  confidence -= attemptPenalty;

  const settlePenalty = Math.max(0, (safeSettle - 50) / 500) * 0.4;
  confidence -= settlePenalty;

  return Math.max(0, Math.min(1, confidence));
}

export async function confirmChange(
  session: CDP.Client,
  getState: () => Promise<Record<string, string>>,
  action: () => Promise<void>,
  options?: ConfirmOptions & {
    precomputedBefore?: Record<string, string>;
    verifyPasses?: number[];
    checkSuccess?: (after: Record<string, string>) => boolean;
  }
): Promise<ConfirmResult> {
  const passes = options?.verifyPasses && options.verifyPasses.length > 0
    ? options.verifyPasses
    : [16, 50, 100, 200, 500];
  const maxAttempts = Math.max(0, options?.maxAttempts ?? passes.length);
  const requireConfirmation = options?.requireConfirmation ?? false;
  const minConfidence = options?.minConfidence ?? 0.5;

  const before = options?.precomputedBefore ?? await getState();
  await action();

  let lastAfter = before;
  let prevSuccessAfter: Record<string, string> | null = null;
  let lastWait = options?.settleMs ?? (passes[0] ?? 16);
  let degraded = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const wait = attempt < passes.length
      ? passes[attempt]!
      : (options?.settleMs ?? 16) + attempt * (options?.retryIncrementMs ?? 100);
    lastWait = wait;

    await new Promise(r => setTimeout(r, wait));
    await waitForDOMStable(session, 50, 200).catch(() => {});

    const after = await getState();
    lastAfter = after;

    logDebug(`[confirmChange] [${wait}ms] Pass ${attempt + 1}: value=${JSON.stringify(after)} (before=${JSON.stringify(before)})`);

    const isSuccess = options?.checkSuccess
      ? options.checkSuccess(after)
      : !shallowEqual(before, after);

    const confidence = calculateConfidence(wait, attempt + 1, maxAttempts);

    if (isSuccess) {
      if (requireConfirmation) {
        if (!prevSuccessAfter || !shallowEqual(prevSuccessAfter, after)) {
          prevSuccessAfter = after;
          if (attempt < maxAttempts - 1) {
            continue;
          }
        }
      }

      if (confidence < minConfidence) {
        logDebug(`[confirmChange] Low confidence (${confidence}) below threshold (${minConfidence})`);
        degraded = true;
      }

      return {
        applied: true,
        before,
        after,
        attempts: attempt + 1,
        settleMs: wait,
        confidence,
        degraded,
      };
    } else {
      prevSuccessAfter = null;
    }
  }

  const finalConfidence = calculateConfidence(lastWait, Math.max(1, maxAttempts), Math.max(1, maxAttempts));
  return {
    applied: false,
    before,
    after: lastAfter,
    attempts: maxAttempts,
    settleMs: lastWait,
    confidence: finalConfidence,
    degraded: true,
  };
}
