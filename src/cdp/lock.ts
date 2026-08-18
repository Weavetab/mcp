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

export interface LockData {
  pid?: number;
  port: number;
  profileDir: string;
  browserPath: string;
  mode: "session" | "attach";
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
const LOCK_FILE = path.join(LOCK_DIR, ".weavetab.lock");
const MUTEX_FILE = path.join(LOCK_DIR, ".weavetab.lock.mutex");

// ─── In-process serialization queue ──────────────────────────────────────────
// When multiple MCP tool calls run in parallel inside the same Node process they
// all race to acquireMutex() simultaneously. The OS-level proper-lockfile handles
// cross-process contention, but within the same process concurrent callers share
// the same lockfile handle and can trigger "Lock is already released" errors.
// This queue serializes callers at the JS level before they touch the filesystem.

let _inProcessMutexQueue: Promise<void> = Promise.resolve();

// Re-entrancy tracking. getOrConnect() acquires the mutex and then calls
// launchWithBridge(), which internally calls writeLock() → acquireMutex()
// again (nested). The serialization queue would block the nested call on the
// outer slot, which only releases after the launch finishes — a self-deadlock.
// Track how many regions this process currently holds and only touch the OS
// file lock + queue slot on the outermost acquisition / release.
let _heldDepth = 0;
let _heldFileRelease: (() => Promise<void>) | null = null;
let _heldSlotResolve: (() => void) | null = null;

async function acquireMutex(): Promise<() => Promise<void>> {
  // Re-entrant fast path: this process already holds the mutex.
  if (_heldDepth > 0) {
    _heldDepth++;
    return async () => {
      _heldDepth--;
    };
  }

  // Enqueue this caller — it will only proceed once all prior callers finish.
  let resolveSlot!: () => void;
  const slot = new Promise<void>(resolve => { resolveSlot = resolve; });
  const prevQueue = _inProcessMutexQueue;
  _inProcessMutexQueue = _inProcessMutexQueue.then(() => slot);
  await prevQueue; // Wait for all prior callers to fully release

  fs.mkdirSync(LOCK_DIR, { recursive: true });
  if (!fs.existsSync(MUTEX_FILE)) {
    try {
      fs.writeFileSync(MUTEX_FILE, String(process.pid), "utf-8");
    } catch { /* race/non-fatal */ }
  }

  let fileRelease: (() => Promise<void>) | null = null;
  try {
    fileRelease = await lock(MUTEX_FILE, {
      retries: {
        retries: 25,
        minTimeout: 200,
        maxTimeout: 1000,
        factor: 1.1,
      },
    });
    // Write current PID to mutex file for diagnostics/HUD
    try {
      fs.writeFileSync(MUTEX_FILE, String(process.pid), "utf-8");
    } catch { /* non-fatal */ }
  } catch (err: any) {
    resolveSlot(); // Unblock the queue even on failure
    throw new Error(`[Weavetab] Could not acquire launch mutex after retries: ${err?.message || err}`);
  }

  // Mark this process as the current holder so nested calls skip the queue.
  _heldDepth = 1;
  _heldFileRelease = fileRelease;
  _heldSlotResolve = resolveSlot;

  // Return a release function that releases both the file lock and the in-process slot
  return async () => {
    _heldDepth--;
    if (_heldDepth > 0) return; // nested regions still active
    _heldDepth = 0;
    const rel = _heldFileRelease;
    const slotResolve = _heldSlotResolve;
    _heldFileRelease = null;
    _heldSlotResolve = null;
    try {
      if (rel) await rel();
    } catch { /* already released — safe to ignore */ }
    if (slotResolve) slotResolve(); // Let the next queued caller proceed
  };
}


// ─── Public API ───────────────────────────────────────────────────────────────

export async function writeLockSafe(data: LockData): Promise<void> {
  const release = await acquireMutex();
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(LOCK_FILE, JSON.stringify(data, null, 2), "utf-8");
  } finally {
    await release();
  }
}

export async function writeLock(data: LockData): Promise<void> {
  await writeLockSafe(data);
}

export function readLock(): LockData | null {
  if (!fs.existsSync(LOCK_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf-8")) as LockData;
  } catch {
    return null;
  }
}

export function clearLock(): void {
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch (e) {
    logDebug(`[Weavetab] [!] Failed to clear lock file: ${e}`);
  }
  try {
    if (fs.existsSync(MUTEX_FILE)) fs.unlinkSync(MUTEX_FILE);
  } catch { /* ignore */ }
  try {
    const lockDir = MUTEX_FILE + ".lock";
    if (fs.existsSync(lockDir)) fs.rmSync(lockDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/**
 * Safe variant: only clears the lock if it was written by THIS process (process.pid).
 * Prevents a second MCP server instance from wiping the first instance's browser lock
 * during its retry loop, which would allow a race condition where two browsers spawn.
 */
export function clearLockIfOwned(): void {
  try {
    const lock = readLock();
    if (!lock || lock.pid !== process.pid) {
      logDebug(`[Weavetab] clearLockIfOwned: skipping — lock owned by PID ${lock?.pid ?? 'none'}, this PID is ${process.pid}`);
      return;
    }
    clearLock();
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
