import CDP from "chrome-remote-interface";
import { waitForDOMStable } from "../sensors/guard.js";
import { logDebug } from "../audit/logger.js";

export interface ConfirmResult {
  applied: boolean;
  before: Record<string, string>;
  after: Record<string, string>;
  attempts: number;
  settleMs: number;
  /** Confidence score (0-1) based on settle time and stability */
  confidence: number;
  /** Whether this is a degraded result due to timeout */
  degraded?: boolean;
}

export interface ConfirmOptions {
  settleMs?: number;
  maxAttempts?: number;
  retryIncrementMs?: number;
  /** If true, requires explicit DOM confirmation before returning */
  requireConfirmation?: boolean;
  /** Minimum confidence threshold to consider successful */
  minConfidence?: number;
}

function shallowEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(k => a[k] === b[k]);
}

/**
 * Calculate confidence score based on settle time and attempts
 * Faster settle with fewer attempts = higher confidence
 */
function calculateConfidence(settleMs: number, attempts: number, maxAttempts: number): number {
  // Base confidence starts at 1.0 and decreases with attempts and settle time
  let confidence = 1.0;
  
  // Penalize multiple attempts
  const attemptPenalty = (attempts - 1) / maxAttempts * 0.3;
  confidence -= attemptPenalty;
  
  // Penalize long settle times (anything over 200ms is slow)
  const settlePenalty = Math.max(0, (settleMs - 50) / 500) * 0.4;
  confidence -= settlePenalty;
  
  // Ensure confidence stays in [0, 1] range
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
  const passes = options?.verifyPasses ?? [16, 50, 100, 200, 500];
  const maxAttempts = options?.maxAttempts ?? passes.length;
  const requireConfirmation = options?.requireConfirmation ?? false;
  const minConfidence = options?.minConfidence ?? 0.5;

  const before = options?.precomputedBefore ?? await getState();
  const startMs = Date.now();
  await action();

  let lastAfter = before;
  let degraded = false;
  
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const wait = attempt < passes.length ? passes[attempt] : (options?.settleMs ?? 16) + attempt * (options?.retryIncrementMs ?? 100);

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
      // If requireConfirmation is true, continue to verify stability
      if (requireConfirmation && attempt < maxAttempts - 1) {
        continue;
      }
      
      // Check confidence threshold
      if (confidence < minConfidence) {
        console.warn("[confirmChange] Low confidence (" + confidence + ") below threshold (" + minConfidence + ")");
        degraded = true;
      }
      
      return { 
        applied: true, 
        before, 
        after, 
        attempts: attempt + 1, 
        settleMs: wait,
        confidence,
        degraded
      };
    }
  }
  
  // If we get here, change was not confirmed
  const finalConfidence = calculateConfidence(passes[maxAttempts - 1], maxAttempts, maxAttempts);
  return { 
    applied: false, 
    before, 
    after: lastAfter, 
    attempts: maxAttempts, 
    settleMs: passes[maxAttempts - 1],
    confidence: finalConfidence,
    degraded: true
  };
}
