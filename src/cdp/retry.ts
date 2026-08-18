import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — cdp/retry.ts
 * Generic CDP retry wrapper for transient connection failures.
 * Retries on: ECONNRESET, WebSocket not open, Target closed, Session not found.
 * Does NOT retry on: element not found, timeout, permission errors.
 * Weavetab by fy2ne
 */

const RETRIABLE_PATTERNS = [
  /ECONNRESET/i,
  /WebSocket.*not.*open/i,
  /Target closed/i,
  /Session.*not found/i,
  /No target with given id/i,
  /protocol error/i,
  /connection refused/i,
];

function isRetriable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return RETRIABLE_PATTERNS.some(p => p.test(msg));
}

export interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
}

export async function cdpRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const { maxRetries = 2, baseDelay = 200 } = opts;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= maxRetries || !isRetriable(err)) {
        throw err;
      }
      const delay = baseDelay * Math.pow(2, attempt);
      logDebug(`[Weavetab CDP] Retrying after transient error (attempt ${attempt + 1}/${maxRetries}): ${err instanceof Error ? err.message : err}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error("[Weavetab CDP] Exhausted retries");
}
