/**
 * Adaptive retry framework for interaction tools
 * Provides intelligent retry logic with multiple strategies and attempt tracking
 */

export interface RetryAttempt {
  strategy: string;
  success: boolean;
  error?: string;
  durationMs: number;
}

export interface RetryResult<T> {
  finalResult: T;
  attempts: RetryAttempt[];
  successfulStrategy: string;
  totalDurationMs: number;
}

export interface RetryOptions {
  maxAttempts?: number;
  strategies?: string[];
  onAttempt?: (attempt: number, strategy: string) => void;
  strategyTimeoutMs?: number;
}

/**
 * Execute an action with adaptive retry using multiple strategies
 * Tries each strategy in sequence until one succeeds or max attempts reached
 */
export async function executeWithRetry<T>(
  strategies: Array<{ name: string; fn: () => Promise<T> }>,
  options: RetryOptions = {}
): Promise<RetryResult<T>> {
  const maxAttempts = options.maxAttempts ?? strategies.length;
  const strategyTimeoutMs = options.strategyTimeoutMs ?? 3000;
  const attempts: RetryAttempt[] = [];
  const startMs = Date.now();

  for (let i = 0; i < Math.min(maxAttempts, strategies.length); i++) {
    const strategy = strategies[i];
    const attemptStartMs = Date.now();

    if (options.onAttempt) {
      options.onAttempt(i + 1, strategy.name);
    }

    try {
      // Clear the timeout timer when strategy.fn() wins the race, otherwise it
      // fires later and creates an unhandled rejected promise.
      let timeoutId: ReturnType<typeof setTimeout>;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Strategy timeout after " + strategyTimeoutMs + "ms")), strategyTimeoutMs);
      });
      const result = await Promise.race([
        strategy.fn().finally(() => clearTimeout(timeoutId!)),
        timeoutPromise,
      ]);

      const attemptDuration = Date.now() - attemptStartMs;
      attempts.push({
        strategy: strategy.name,
        success: true,
        durationMs: attemptDuration,
      });

      return {
        finalResult: result,
        attempts,
        successfulStrategy: strategy.name,
        totalDurationMs: Date.now() - startMs,
      };
    } catch (error) {
      const attemptDuration = Date.now() - attemptStartMs;
      attempts.push({
        strategy: strategy.name,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: attemptDuration,
      });

      // If this is the last attempt, throw the error
      if (i === Math.min(maxAttempts, strategies.length) - 1) {
        throw new Error("All " + strategies.length + " strategies failed. Last error: " + error);
      }

      // Otherwise, continue to next strategy
      process.stderr.write("[executeWithRetry] Strategy \"" + strategy.name + "\" failed, trying next strategy. Error: " + error + "\n");
    }
  }

  // This should never be reached, but TypeScript needs it
  throw new Error('No strategies were provided or all failed');
}

/**
 * Create a timeout wrapper for any async function
 */
// Same orphan-timer handling as the strategy timeout above.
export function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  timeoutError: string = "Operation timed out after " + timeoutMs + "ms"
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutError)), timeoutMs);
  });
  return Promise.race([
    fn().finally(() => clearTimeout(timeoutId!)),
    timeoutPromise,
  ]);
}

/**
 * Execute with exponential backoff retry
 * For operations that might succeed on retry due to transient failures
 */
export async function executeWithBackoff<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
  } = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const initialDelayMs = options.initialDelayMs ?? 100;
  const maxDelayMs = options.maxDelayMs ?? 2000;
  const backoffMultiplier = options.backoffMultiplier ?? 2;

  let lastError: Error | undefined;
  let delay = initialDelayMs;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      if (attempt < maxAttempts - 1) {
        process.stderr.write("[executeWithBackoff] Attempt " + (attempt + 1) + " failed, retrying in " + delay + "ms. Error: " + error + "\n");
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * backoffMultiplier, maxDelayMs);
      }
    }
  }

  throw lastError || new Error('Max retry attempts reached');
}
