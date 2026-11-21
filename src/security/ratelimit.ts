import type { Config } from "../config/loader.js";
import { getConfigMaxActionsPerMinute } from "../config/loader.js";

export interface RateLimitAllowed {
  allowed: true;
}

export interface RateLimitBlocked {
  allowed: false;
  retryAfterMs: number;
}

export type RateLimitResult = RateLimitAllowed | RateLimitBlocked;

const WINDOW_MS = 60_000;
let timestamps: number[] = [];

function validateAgentId(agentId: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,64}$/.test(agentId);
}

export function checkRateLimit(configOrLimit: Config | number): RateLimitResult {
  let maxPerMin: number;
  if (typeof configOrLimit === "number") {
    maxPerMin = configOrLimit;
  } else {
    if (configOrLimit.agentId && !validateAgentId(configOrLimit.agentId)) {
      console.error(`[SECURITY] Invalid agentId format detected: ${configOrLimit.agentId}`);
    }
    maxPerMin = getConfigMaxActionsPerMinute(configOrLimit) ?? 60;
  }

  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  timestamps = timestamps.filter((t) => t > windowStart);

  if (timestamps.length >= maxPerMin) {
    const oldestInWindow = timestamps[0]!;
    const retryAfterMs = Math.max(1, oldestInWindow + WINDOW_MS - now);
    return { allowed: false, retryAfterMs };
  }

  timestamps.push(now);
  return { allowed: true };
}

export function resetRateLimit(): void {
  timestamps = [];
}
