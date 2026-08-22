import { logDebug } from "../audit/logger.js";
/**
 * Weavetab — cdp/lock.ts
 * Crash-safe, mutex-protected lock file for browser process tracking.
 * Uses proper-lockfile for OS-level advisory locking to prevent race conditions.
 * Weavetab by fy2ne
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { lock } from "proper-lockfile";

import { sanitizeAppName } from "./profiles.js";

export interface LockData {
  pid?: number;
  port: number;
  profileDir: string;
  browserPath: string;
  mode: "session" | "attach";
  appName?: string;
  pending?: boolean;
  timestamp?: number;
  // Browser fingerprinting data
  fingerprint?: {
    launchTimestamp: number;
    userAgent?: string;
    cdpVersion?: string;
  };
}

const LOCK_DIR = path.join(os.homedir(), ".weavetab-system", "locks");

export function getLockFilePath(appName?: string): string {
  if (appName && appName.trim()) {
    return path.join(LOCK_DIR, `.weavetab.electron.${sanitizeAppName(appName)}.lock`);
  }
  return path.join(LOCK_DIR, ".weavetab.lock");
}

export function getMutexFilePath(appName?: string): string {
  if (appName && appName.trim()) {
    return path.join(LOCK_DIR, `.weavetab.electron.${sanitizeAppName(appName)}.lock.mutex`);
  }
  return path.join(LOCK_DIR, ".weavetab.lock.mutex");
}

// ─── In-process serialization queues per app/browser ──────────────────────────

const _inProcessQueues = new Map<string, Promise<void>>();
const _heldDepths = new Map<string, number>();
const _heldFileReleases = new Map<string, (() => Promise<void>) | null>();
const _heldSlotResolves = new Map<string, (() => void) | null>();

function getTargetKey(appName?: string): string {
  return appName && appName.trim() ? `electron:${sanitizeAppName(appName)}` : "browser";
}

async function acquireMutex(appName?: string): Promise<() => Promise<void>> {
  const key = getTargetKey(appName);
  const currentDepth = _heldDepths.get(key) ?? 0;

  // Re-entrant fast path: this process already holds the mutex for this target.
  if (currentDepth > 0) {
    _heldDepths.set(key, currentDepth + 1);
    return async () => {
      const d = (_heldDepths.get(key) ?? 1) - 1;
      _heldDepths.set(key, Math.max(0, d));
    };
  }

  // Enqueue this caller for this specific key
  let resolveSlot!: () => void;
  const slot = new Promise<void>(resolve => { resolveSlot = resolve; });
  const prevQueue = _inProcessQueues.get(key) ?? Promise.resolve();
  _inProcessQueues.set(key, prevQueue.then(() => slot));
  await prevQueue; // Wait for all prior callers for this key to fully release

  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const mutexFile = getMutexFilePath(appName);
  if (!fs.existsSync(mutexFile)) {
    try {
      fs.writeFileSync(mutexFile, String(process.pid), "utf-8");
    } catch { /* race/non-fatal */ }
  }

  let fileRelease: (() => Promise<void>) | null = null;
  try {
    fileRelease = await lock(mutexFile, {
      retries: {
        retries: 25,
        minTimeout: 200,
        maxTimeout: 1000,
        factor: 1.1,
      },
    });
    // Write current PID to mutex file for diagnostics/HUD
    try {
      fs.writeFileSync(mutexFile, String(process.pid), "utf-8");
    } catch { /* non-fatal */ }
  } catch (err: any) {
    resolveSlot(); // Unblock the queue even on failure
    throw new Error(`[Weavetab] Could not acquire launch mutex for ${key} after retries: ${err?.message || err}`);
  }

  // Mark this process as the current holder so nested calls skip the queue.
  _heldDepths.set(key, 1);
  _heldFileReleases.set(key, fileRelease);
  _heldSlotResolves.set(key, resolveSlot);

  // Return a release function that releases both the file lock and the in-process slot
  return async () => {
    const d = (_heldDepths.get(key) ?? 1) - 1;
    _heldDepths.set(key, Math.max(0, d));
    if (d > 0) return; // nested regions still active
    _heldDepths.delete(key);
    const rel = _heldFileReleases.get(key);
    const slotResolve = _heldSlotResolves.get(key);
    _heldFileReleases.delete(key);
    _heldSlotResolves.delete(key);
    try {
      if (rel) await rel();
    } catch { /* already released — safe to ignore */ }
    if (slotResolve) slotResolve(); // Let the next queued caller proceed
  };
}


// ─── Public API ───────────────────────────────────────────────────────────────

export async function writeLockSafe(data: LockData, appName?: string): Promise<void> {
  const targetApp = appName || data.appName;
  const release = await acquireMutex(targetApp);
  const lockFile = getLockFilePath(targetApp);
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(lockFile, JSON.stringify(data, null, 2), "utf-8");
  } finally {
    await release();
  }
}

export async function writeLock(data: LockData, appName?: string): Promise<void> {
  await writeLockSafe(data, appName);
}

export function readLock(appName?: string): LockData | null {
  const lockFile = getLockFilePath(appName);
  if (!fs.existsSync(lockFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockFile, "utf-8")) as LockData;
  } catch {
    return null;
  }
}

export function clearLock(appName?: string): void {
  const lockFile = getLockFilePath(appName);
  const mutexFile = getMutexFilePath(appName);
  try {
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch (e) {
    logDebug(`[Weavetab] [!] Failed to clear lock file: ${e}`);
  }
  try {
    if (fs.existsSync(mutexFile)) fs.unlinkSync(mutexFile);
  } catch { /* ignore */ }
  try {
    const lockDir = mutexFile + ".lock";
    if (fs.existsSync(lockDir)) fs.rmSync(lockDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Safe variant: only clears the lock if it was written by THIS process (process.pid).
 * Prevents a second MCP server instance from wiping the first instance's browser lock
 * during its retry loop, which would allow a race condition where two browsers spawn.
 */
export function clearLockIfOwned(appName?: string): void {
  try {
    const lock = readLock(appName);
    if (!lock || lock.pid !== process.pid) {
      logDebug(`[Weavetab] clearLockIfOwned: skipping — lock owned by PID ${lock?.pid ?? 'none'}, this PID is ${process.pid}`);
      return;
    }
    clearLock(appName);
  } catch (e) {
    logDebug(`[Weavetab] clearLockIfOwned error: ${e}`);
  }
}

export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Two-factor lock validation: PID alive AND port accepting TCP connections.
 * Prevents PID-reuse false-positives after a crash.
 */
export async function isLockValid(lock: LockData): Promise<boolean> {
  // Factor 1: PID alive
  if (lock.pid && !isProcessRunning(lock.pid)) {
    logDebug(`[Weavetab CDP] Lock invalid: Process ${lock.pid} is not running.`);
    return false;
  }

  // Factor 2: TCP port accepting connections
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      logDebug(`[Weavetab CDP] Lock invalid: Timeout connecting to port ${lock.port}.`);
      socket.destroy();
      resolve(false);
    }, 1000); // Reduced timeout to 1s for faster validation
    socket.connect(lock.port, "127.0.0.1", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", (err) => {
      logDebug(`[Weavetab CDP] Lock invalid: Error connecting to port ${lock.port} - ${err.message}`);
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

export function isLockPending(lock: LockData): boolean {
  if (!lock.pending) return false;
  // If it's been pending for more than 15 seconds, consider it stale/failed
  if (lock.timestamp && Date.now() - lock.timestamp > 15000) {
    return false;
  }
  return true;
}

export { acquireMutex };

