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

// Circular buffer of timestamps per connection — one slot per allowed action in the window
const WINDOW_MS = 60_000;
const connectionTimestamps = new Map<string, number[]>();

// Sweep old/unused connection IDs every 2 minutes so entries where all
// timestamps have expired (agent idle for >1 window) are removed instead of
// accumulating without bound.
setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [id, ts] of connectionTimestamps.entries()) {
    if (ts.every(t => t <= cutoff)) connectionTimestamps.delete(id);
  }
}, 120_000).unref();

// Validate agentId format to prevent manipulation
function validateAgentId(agentId: string): boolean {
  // Only allow alphanumeric, underscore, dash, and dot
  // This prevents special characters and path manipulation attempts
  const validPattern = /^[a-zA-Z0-9_.-]{1,64}$/;
  return validPattern.test(agentId);
}

// Generate a unique connection ID for rate limiting
let connectionCounter = 0;
function generateConnectionId(): string {
  return `conn_${Date.now()}_${++connectionCounter}`;
}

// Current connection ID for this session
let currentConnectionId: string = generateConnectionId();

export function checkRateLimit(config: Config): RateLimitResult {
  // Rate-limit per connection rather than per agentId so an attacker can't
  // manipulate agentId to get fresh buckets.
  const connectionId = currentConnectionId;
  
  // Validate agentId format if provided, but don't use it for rate limiting
  if (config.agentId && !validateAgentId(config.agentId)) {
    // Log warning but don't block - the connection ID is still used for rate limiting
    console.error(`[SECURITY] Invalid agentId format detected: ${config.agentId}`);
  }
  
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Evict expired timestamps (sliding window)
  let timestamps = connectionTimestamps.get(connectionId) || [];
  timestamps = timestamps.filter((t) => t > windowStart);

  if (timestamps.length >= getConfigMaxActionsPerMinute(config)) {
    // Oldest timestamp tells us when a slot frees up
    const oldestInWindow = timestamps[0]!;
    const retryAfterMs = oldestInWindow + WINDOW_MS - now;
    return { allowed: false, retryAfterMs };
  }

  timestamps.push(now);
  connectionTimestamps.set(connectionId, timestamps);
  return { allowed: true };
}

export function resetRateLimit(): void {
  connectionTimestamps.clear();
  // Generate a new connection ID on reset
  currentConnectionId = generateConnectionId();
}
