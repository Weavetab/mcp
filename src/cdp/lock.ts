import { logDebug } from "../audit/logger.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as net from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
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

const _inProcessQueues = new Map<string, Promise<void>>();
const _heldDepths = new Map<string, number>();
const _heldFileReleases = new Map<string, (() => Promise<void>) | null>();
const _heldSlotResolves = new Map<string, (() => void) | null>();
const _heldMutexStorage = new AsyncLocalStorage<Set<string>>();

function getTargetKey(appName?: string): string {
  return appName && appName.trim() ? `electron:${sanitizeAppName(appName)}` : "browser";
}

function getCallerIdentity(): string {
  const stack = new Error().stack || "";
  const lines = stack.split("\n").map(l => l.trim());
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.includes("acquireMutex") && !line.includes("getCallerIdentity")) {
      return line;
    }
  }
  return "";
}

const _holderCallerFrame = new Map<string, string>();

async function releaseMutexForKey(key: string): Promise<void> {
  const d = (_heldDepths.get(key) ?? 1) - 1;
  if (d > 0) {
    _heldDepths.set(key, d);
    return;
  }
  _heldDepths.delete(key);
  _holderCallerFrame.delete(key);

  const rel = _heldFileReleases.get(key);
  const slotResolve = _heldSlotResolves.get(key);
  _heldFileReleases.delete(key);
  _heldSlotResolves.delete(key);

  try {
    if (rel) await rel();
  } catch { /* already released */ }
  if (slotResolve) slotResolve();
}

export async function acquireMutex(appName?: string): Promise<() => Promise<void>> {
  const key = getTargetKey(appName);
  const ctxSet = _heldMutexStorage.getStore();
  const callerFrame = getCallerIdentity();

  const isReentrant =
    (_heldDepths.get(key) ?? 0) > 0 &&
    ((ctxSet && ctxSet.has(key)) ||
      (callerFrame.includes("writeLock") && !_holderCallerFrame.get(key)?.includes("writeLock")));

  if (isReentrant) {
    _heldDepths.set(key, (_heldDepths.get(key) ?? 1) + 1);
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await releaseMutexForKey(key);
    };
  }

  let resolveSlot!: () => void;
  const slot = new Promise<void>(resolve => { resolveSlot = resolve; });
  const prevQueue = _inProcessQueues.get(key) ?? Promise.resolve();
  _inProcessQueues.set(key, prevQueue.then(() => slot));

  await prevQueue;

  const mutexFile = getMutexFilePath(appName);
  const mutexDir = path.dirname(mutexFile);
  fs.mkdirSync(mutexDir, { recursive: true });
  if (!fs.existsSync(mutexFile)) {
    try {
      fs.writeFileSync(mutexFile, String(process.pid), "utf-8");
    } catch { /* non-fatal */ }
  }

  let fileRelease: (() => Promise<void>) | null = null;
  try {
    fileRelease = await lock(mutexFile, {
      stale: 60000,
      onCompromised: () => {},
      retries: {
        retries: 10,
        minTimeout: 50,
        maxTimeout: 300,
        factor: 1.1,
      },
    });
    try {
      fs.writeFileSync(mutexFile, String(process.pid), "utf-8");
    } catch { /* non-fatal */ }
  } catch (err: any) {
    resolveSlot();
    throw new Error(`[Weavetab] Could not acquire launch mutex for ${key} after retries: ${err?.message || err}`);
  }

  _holderCallerFrame.set(key, callerFrame);
  _heldDepths.set(key, 1);
  _heldFileReleases.set(key, fileRelease);
  _heldSlotResolves.set(key, resolveSlot);

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await releaseMutexForKey(key);
  };
}

export async function withMutex<T>(appName: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = getTargetKey(appName);
  const prev = _heldMutexStorage.getStore();
  const next = new Set<string>(prev ?? []);
  next.add(key);
  return _heldMutexStorage.run(next, async () => {
    const release = await acquireMutex(appName);
    try {
      return await fn();
    } finally {
      await release();
    }
  });
}

export async function writeLock(data: LockData, appName?: string): Promise<void> {
  const targetApp = appName || data.appName;
  const release = await acquireMutex(targetApp);
  const lockFile = getLockFilePath(targetApp);
  const tmpFile = `${lockFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(LOCK_DIR, { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmpFile, lockFile);
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    await release();
  }
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
  try {
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch (e) {
    logDebug(`[Weavetab] [!] Failed to clear lock file: ${e}`);
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

export const isPidAlive = isProcessRunning;

export async function isLockValid(lockData: LockData): Promise<boolean> {
  if (!Boolean(lockData.pid) || !isPidAlive(lockData.pid!)) {
    logDebug(`[Weavetab CDP] Lock invalid: Process ${lockData.pid} is not running.`);
    return false;
  }

  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    const timeout = setTimeout(() => {
      logDebug(`[Weavetab CDP] Lock invalid: Timeout connecting to port ${lockData.port}.`);
      socket.destroy();
      resolve(false);
    }, 1000);
    socket.connect(lockData.port, "127.0.0.1", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.on("error", (err) => {
      logDebug(`[Weavetab CDP] Lock invalid: Error connecting to port ${lockData.port} - ${err.message}`);
      clearTimeout(timeout);
      socket.destroy();
      resolve(false);
    });
  });
}

export function isLockPending(lockData: LockData): boolean {
  if (!lockData.pending) return false;
  if (lockData.timestamp && Date.now() - lockData.timestamp > 15000) {
    return false;
  }
  return true;
}
