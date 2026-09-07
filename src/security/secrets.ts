/**
 * Weavetab — security/secrets.ts
 * Structured secret store with per-key domain scoping and chmod 600 enforcement.
 * Replaces the old EnvSecretProvider (.env-based) with a JSON secret store.
 *
 * Storage locations:
 *   - Global default:  ~/.weavetab/secrets.json
 *
 * File format:
 *   {
 *     "version": 1,
 *     "secrets": {
 *       "MY_KEY": {
 *         "value": "s3cr3t",
 *         "domains": ["github.com", "gitlab.com"],
 *         "createdAt": "2024-01-01T00:00:00Z",
 *         "updatedAt": "2024-01-01T00:00:00Z"
 *       }
 *     }
 *   }
 *
 * Security guarantees:
 *   - File created with mode 0o600 (owner-read/write only).
 *   - On POSIX: startup hard-fails if file exists with wrong permissions.
 *   - On Windows: warning only (NTFS ACLs, not POSIX mode bits).
 *   - Resolved value lives in-process only; never returned in any tool_result.
 *   - `domains: []` means "any domain" — not recommended for sensitive credentials.
 *
 * Weavetab by fy2ne
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// Encryption key derivation for secrets at rest
const ENCRYPTION_KEY_FILE = path.join(os.homedir(), ".weavetab-system", "secrets-key");
let encryptionKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (encryptionKey) return encryptionKey;
  
  try {
    if (fs.existsSync(ENCRYPTION_KEY_FILE)) {
      const keyData = fs.readFileSync(ENCRYPTION_KEY_FILE, "utf-8").trim();
      encryptionKey = Buffer.from(keyData, "hex");
    } else {
      // Generate a new encryption key
      encryptionKey = crypto.randomBytes(32); // 256-bit key
      const dir = path.dirname(ENCRYPTION_KEY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(ENCRYPTION_KEY_FILE, encryptionKey.toString("hex"), { mode: 0o600 });
    }
  } catch {
    // Fallback to a derived key if file operations fail
    const machineId = os.hostname() + os.platform() + os.arch();
    encryptionKey = crypto.createHash("sha256").update(machineId).digest();
  }
  
  return encryptionKey;
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  
  const authTag = cipher.getAuthTag();
  
  // Combine IV + authTag + encrypted data
  return iv.toString("hex") + authTag.toString("hex") + encrypted;
}

function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();
  
  // Extract IV (first 32 hex chars = 16 bytes)
  const iv = Buffer.from(ciphertext.slice(0, 32), "hex");
  
  // Extract authTag (next 32 hex chars = 16 bytes)
  const authTag = Buffer.from(ciphertext.slice(32, 64), "hex");
  
  // Extract encrypted data
  const encrypted = ciphertext.slice(64);
  
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  
  return decrypted;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SecretEntry {
  value: string; // Stored encrypted at rest
  /** Allowed hostnames. Empty array = any domain (strongly discouraged). */
  domains: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SecretsFile {
  version: 1;
  secrets: Record<string, SecretEntry>;
}

export interface SecretProvider {
  getSecret(key: string): Promise<string | undefined>;
}

export interface SecretListEntry {
  key: string;
  domains: string[];
  updatedAt: string;
}

import { GLOBAL_CONFIG_DIR } from "../config/loader.js";

// ─── Path resolution ──────────────────────────────────────────────────────────

export const GLOBAL_SECRETS_PATH = path.join(GLOBAL_CONFIG_DIR, "secrets.json");

function resolveSecretsPath(): string {
  return GLOBAL_SECRETS_PATH;
}

// ─── Permission guard ─────────────────────────────────────────────────────────

const IS_WINDOWS = os.platform() === "win32";
const REQUIRED_MODE = 0o600;

/**
 * Enforce chmod 600 on the secrets file.
 * Hard-fails on POSIX if the file is accessible by anyone other than the owner.
 * Warns on Windows (NTFS doesn't map cleanly to POSIX mode bits).
 */
function enforceFilePermissions(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  if (IS_WINDOWS) {
    try {
      const { execFileSync } = require('child_process');
      const username = process.env.USERNAME || '';
      // Validate username against a strict allowlist pattern, then pass filePath
      // and the grant argument as separate argv tokens to execFile (no shell
      // involved) so the username can never be injected into a command string.
      if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
        process.stderr.write(`[Weavetab Secrets] ⚠ Refusing to set ACLs: USERNAME contains unsafe characters.\n`);
        return;
      }
      // Pass each argument as a separate element — no shell, no injection possible
      execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${username}:F`], { stdio: 'ignore' });
    } catch (e) {
      process.stderr.write(`[Weavetab Secrets] ⚠ Failed to enforce Windows ACLs on "${filePath}".\n`);
    }
    return;
  }

  try {
    const stats = fs.statSync(filePath);
    const mode = stats.mode & 0o777;
    if (mode !== REQUIRED_MODE) {
      throw new Error(
        `[Weavetab Secrets] ✗ SECURITY ERROR: Secrets file "${filePath}" has unsafe permissions ` +
        `(${mode.toString(8)}, expected 600). ` +
        `Fix with: chmod 600 "${filePath}"`
      );
    }
  } catch (e: any) {
    if (e.message.includes("SECURITY ERROR")) throw e;
    // stat failed for some other reason — skip
  }
}

function applyFilePermissions(filePath: string): void {
  if (IS_WINDOWS) {
    enforceFilePermissions(filePath);
    return;
  }
  try {
    fs.chmodSync(filePath, REQUIRED_MODE);
  } catch { /* ignore — might be on a FS that doesn't support chmod */ }
}



// ─── File I/O ─────────────────────────────────────────────────────────────────

function readSecretsFile(filePath: string): SecretsFile {
  enforceFilePermissions(filePath);

  if (!fs.existsSync(filePath)) {
    return { version: 1, secrets: {} };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return { version: 1, secrets: {} };
    const parsed = JSON.parse(raw) as SecretsFile;
    if (typeof parsed !== "object" || parsed.version !== 1 || typeof parsed.secrets !== "object") {
      throw new Error("Malformed secrets file");
    }
    
    // Decrypt secret values after reading
    for (const key in parsed.secrets) {
      if (parsed.secrets[key].value) {
        try {
          parsed.secrets[key].value = decrypt(parsed.secrets[key].value);
        } catch {
          // If decryption fails, assume it's not encrypted (legacy data)
          // and leave it as-is
        }
      }
    }
    
    return parsed;
  } catch (e: any) {
    throw new Error(`[Weavetab Secrets] ✗ Failed to read secrets file "${filePath}": ${e.message}`);
  }
}

function writeSecretsFile(filePath: string, data: SecretsFile): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Encrypt secret values before writing
  const encryptedData: SecretsFile = {
    version: data.version,
    secrets: {}
  };
  
  for (const key in data.secrets) {
    encryptedData.secrets[key] = {
      ...data.secrets[key],
      value: encrypt(data.secrets[key].value)
    };
  }

  const tmp = filePath + `.tmp.${process.pid}.${crypto.randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(encryptedData, null, 2), { encoding: "utf-8", mode: REQUIRED_MODE });
    applyFilePermissions(tmp);
    fs.renameSync(tmp, filePath);
    applyFilePermissions(filePath);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

// ─── JsonSecretStore ──────────────────────────────────────────────────────────

class JsonSecretStoreImpl implements SecretProvider {

  /**
   * Resolve a secret value by key.
   * Returns undefined if the key doesn't exist.
   * Does NOT check domain — use checkDomain() for that before calling this.
   */
  async getSecret(key: string): Promise<string | undefined> {
    const filePath = resolveSecretsPath();
    const data = readSecretsFile(filePath);
    const entry = data.secrets[key];
    return entry?.value;
  }

  /**
   * Check whether the given hostname is allowed for this key.
   * Returns true if:
   *   - The key doesn't exist (will fail at getSecret time anyway)
   *   - The key's domains list is empty (wildcard — any domain)
   *   - The hostname matches one of the allowed domains (exact or suffix match)
   */
  checkDomain(key: string, hostname: string): boolean {
    const filePath = resolveSecretsPath();
    const data = readSecretsFile(filePath);
    const entry = data.secrets[key];
    if (!entry) return false;                         // key not found
    if (entry.domains.length === 0) return true;      // wildcard
    const h = hostname.toLowerCase();
    return entry.domains.some(d => {
      const allowed = d.toLowerCase();
      return h === allowed || h.endsWith("." + allowed);
    });
  }

  /**
   * Get the allowed domains list for a key (for error messages).
   * Never returns the value.
   */
  getDomains(key: string): string[] | null {
    const filePath = resolveSecretsPath();
    const data = readSecretsFile(filePath);
    const entry = data.secrets[key];
    return entry ? entry.domains : null;
  }

  /**
   * Store a secret. Value must be passed in-process — never as a CLI arg.
   * domains: list of allowed hostnames. Empty = any domain (not recommended).
   */
  async setSecret(key: string, value: string, domains: string[]): Promise<void> {
    if (!key || !key.trim()) throw new Error("Secret key cannot be empty");
    if (!value) throw new Error("Secret value cannot be empty");

    const filePath = resolveSecretsPath();
    const data = readSecretsFile(filePath);
    const now = new Date().toISOString();
    const existing = data.secrets[key];
    data.secrets[key] = {
      value,
      domains: domains.map(d => d.toLowerCase().trim()).filter(Boolean),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    writeSecretsFile(filePath, data);
  }

  /**
   * List all secrets — returns key names, domains, and timestamps ONLY.
   * Never returns values.
   */
  async listSecrets(): Promise<SecretListEntry[]> {
    const filePath = resolveSecretsPath();
    const data = readSecretsFile(filePath);
    return Object.entries(data.secrets).map(([key, entry]) => ({
      key,
      domains: entry.domains,
      updatedAt: entry.updatedAt,
    }));
  }

  /**
   * Remove a secret by key. Returns true if the key existed and was removed.
   */
  async removeSecret(key: string): Promise<boolean> {
    const filePath = resolveSecretsPath();
    const data = readSecretsFile(filePath);
    if (!data.secrets[key]) return false;
    delete data.secrets[key];
    writeSecretsFile(filePath, data);
    return true;
  }

  /** Returns the active secrets file path for display purposes. */
  getSecretsFilePath(): string {
    return resolveSecretsPath();
  }
}

export const secretStore = new JsonSecretStoreImpl();

// ─── Legacy shim — kept so other callers don't break ─────────────────────────
// @deprecated — use secretStore directly

/** @deprecated Use secretStore instead. */
export class EnvSecretProvider implements SecretProvider {
  async getSecret(key: string): Promise<string | undefined> {
    process.stderr.write(
      `[Weavetab Secrets] ⚠ EnvSecretProvider is deprecated. Falling back to JsonSecretStore.\n`
    );
    return secretStore.getSecret(key);
  }
}

// ─── SessionSecretTracker ─────────────────────────────────────────────────────
// Tracks which DOM backendNodeIds contain secrets so cross-tool redaction
// (walker, AX tree, delta) can redact them at read time without re-querying
// the secret store.

class SessionSecretTrackerImpl {
  /** Maps sessionId (CDP targetId) → Set of backendNodeIds marked as secret. */
  private trackedNodes = new Map<string, Set<number>>();
  /** Maps sessionId (CDP targetId) → Set of plaintext secret strings injected. */
  private sessionSecrets = new Map<string, Set<string>>();

  markNodeAsSecret(sessionId: string, backendNodeId: number): void {
    let set = this.trackedNodes.get(sessionId);
    if (!set) {
      set = new Set<number>();
      this.trackedNodes.set(sessionId, set);
    }
    set.add(backendNodeId);
  }

  isNodeSecret(sessionId: string, backendNodeId: number): boolean {
    const set = this.trackedNodes.get(sessionId);
    return set ? set.has(backendNodeId) : false;
  }

  registerSecretValue(sessionId: string, value: string): void {
    if (!value || value.length < 3) return; // Don't redact tiny strings
    let set = this.sessionSecrets.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this.sessionSecrets.set(sessionId, set);
    }
    set.add(value);
  }

  redact(sessionId: string, text: string): string {
    if (!text || typeof text !== 'string') return text;
    const set = this.sessionSecrets.get(sessionId);
    if (!set || set.size === 0) return text;
    
    let redacted = text;
    for (const secret of set) {
      // Fast path string replace all instances
      redacted = redacted.split(secret).join('[REDACTED]');
    }
    return redacted;
  }

  redactAll(text: string): string {
    if (!text || typeof text !== 'string') return text;
    let redacted = text;
    for (const set of this.sessionSecrets.values()) {
      for (const secret of set) {
        if (secret && secret.length >= 3) {
          redacted = redacted.split(secret).join('[REDACTED]');
        }
      }
    }
    return redacted;
  }

  clearSession(sessionId: string): void {
    this.trackedNodes.delete(sessionId);
    this.sessionSecrets.delete(sessionId);
  }
}

export const SessionSecretTracker = new SessionSecretTrackerImpl();
