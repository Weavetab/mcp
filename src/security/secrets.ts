import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const HOME_DIR = os.homedir();
const LOWER_GLOBAL = path.join(HOME_DIR, ".weavetab");
const UPPER_GLOBAL = path.join(HOME_DIR, ".Weavetab");
const RESOLVED_GLOBAL_CONFIG_DIR = fs.existsSync(LOWER_GLOBAL)
  ? LOWER_GLOBAL
  : fs.existsSync(UPPER_GLOBAL)
  ? UPPER_GLOBAL
  : LOWER_GLOBAL;

const IS_WINDOWS = os.platform() === "win32";
const REQUIRED_MODE = 0o600;

export function enforceFilePermissions(filePath: string): void {
  if (!fs.existsSync(filePath)) return;

  if (IS_WINDOWS) {
    try {
      const username = process.env.USERNAME || "";
      if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
        process.stderr.write(`[Weavetab Secrets] ⚠ Refusing to set ACLs: USERNAME contains unsafe characters.\n`);
        return;
      }
      execFileSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${username}:F`], { stdio: "ignore" });
    } catch {
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
          `(${mode.toString(8)}, expected 600). Fix with: chmod 600 "${filePath}"`
      );
    }
  } catch (e: any) {
    if (e?.message?.includes("SECURITY ERROR")) throw e;
  }
}

export function applyFilePermissions(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  if (IS_WINDOWS) {
    enforceFilePermissions(filePath);
    return;
  }
  try {
    fs.chmodSync(filePath, REQUIRED_MODE);
  } catch { /* ignore */ }
}

const ENCRYPTION_KEY_FILE = path.join(os.homedir(), ".weavetab-system", "secrets-key");
let encryptionKey: Buffer | null = null;

export function getEncryptionKey(keyFilePath: string = ENCRYPTION_KEY_FILE): Buffer {
  if (keyFilePath === ENCRYPTION_KEY_FILE && encryptionKey) return encryptionKey;

  let keyBuf: Buffer;
  if (fs.existsSync(keyFilePath)) {
    enforceFilePermissions(keyFilePath);
    const keyData = fs.readFileSync(keyFilePath, "utf-8").trim();
    if (!/^[0-9a-fA-F]{64}$/.test(keyData)) {
      throw new Error(`[Weavetab Secrets] ✗ Invalid encryption key format in "${keyFilePath}"`);
    }
    keyBuf = Buffer.from(keyData, "hex");
  } else {
    keyBuf = crypto.randomBytes(32);
    const dir = path.dirname(keyFilePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyFilePath, keyBuf.toString("hex"), { mode: REQUIRED_MODE });
    applyFilePermissions(keyFilePath);
  }

  if (keyFilePath === ENCRYPTION_KEY_FILE) {
    encryptionKey = keyBuf;
  }
  return keyBuf;
}

export function encrypt(plaintext: string, customKey?: Buffer): string {
  const key = customKey ?? getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();
  return iv.toString("hex") + authTag.toString("hex") + encrypted;
}

export function decrypt(ciphertext: string, customKey?: Buffer): string {
  const key = customKey ?? getEncryptionKey();

  let ivHex: string;
  let tagHex: string;
  let encHex: string;

  if (ciphertext.includes(":")) {
    const parts = ciphertext.split(":");
    if (parts.length !== 3) {
      throw new Error("Malformed encrypted secret format");
    }
    [ivHex, tagHex, encHex] = parts as [string, string, string];
  } else {
    if (ciphertext.length < 66 || ciphertext.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(ciphertext)) {
      throw new Error("Malformed encrypted secret payload");
    }
    ivHex = ciphertext.slice(0, 32);
    tagHex = ciphertext.slice(32, 64);
    encHex = ciphertext.slice(64);
  }

  if (!/^[0-9a-fA-F]{24,32}$/.test(ivHex) || !/^[0-9a-fA-F]{32}$/.test(tagHex) || !/^[0-9a-fA-F]+$/.test(encHex)) {
    throw new Error("Invalid hex components in encrypted secret");
  }

  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export interface SecretEntry {
  value: string;
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

export const GLOBAL_SECRETS_PATH = path.join(RESOLVED_GLOBAL_CONFIG_DIR, "secrets.json");
export const PROJECT_SECRETS_DIRNAME = ".weavetab";
export const PROJECT_SECRETS_FILENAME = "secrets.json";

export function getProjectSecretsPath(cwd: string = process.cwd()): string {
  return path.join(cwd, PROJECT_SECRETS_DIRNAME, PROJECT_SECRETS_FILENAME);
}

export function initProjectSecrets(cwd: string = process.cwd()): string {
  const filePath = getProjectSecretsPath(cwd);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, secrets: {} }, null, 2),
      { mode: REQUIRED_MODE }
    );
  }
  applyFilePermissions(filePath);
  return filePath;
}

export function resolveSecretsPath(cwd: string = process.cwd()): string {
  try {
    const normCwd = path.resolve(cwd);
    const normHome = path.resolve(os.homedir());
    if (process.env.WT_PROJECT_SECRETS === "1" || normCwd === normHome) {
      const projectPath = getProjectSecretsPath(normCwd);
      if (fs.existsSync(projectPath)) return projectPath;
    }
  } catch {
    // fall through
  }
  return GLOBAL_SECRETS_PATH;
}

function readSecretsFile(filePath: string): SecretsFile {
  enforceFilePermissions(filePath);

  if (!fs.existsSync(filePath)) {
    return { version: 1, secrets: {} };
  }

  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return { version: 1, secrets: {} };
    const parsed = JSON.parse(raw) as SecretsFile;
    if (typeof parsed !== "object" || parsed === null || parsed.version !== 1 || typeof parsed.secrets !== "object" || parsed.secrets === null) {
      throw new Error("Malformed secrets file");
    }

    for (const key of Object.keys(parsed.secrets)) {
      if (!Object.hasOwn(parsed.secrets, key)) continue;
      const entry = parsed.secrets[key];
      if (entry && typeof entry.value === "string" && entry.value.length > 0) {
        entry.value = decrypt(entry.value);
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

  const encryptedData: SecretsFile = {
    version: data.version,
    secrets: {},
  };

  for (const key of Object.keys(data.secrets)) {
    if (!Object.hasOwn(data.secrets, key)) continue;
    encryptedData.secrets[key] = {
      ...data.secrets[key]!,
      value: encrypt(data.secrets[key]!.value),
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

class JsonSecretStoreImpl implements SecretProvider {
  async getSecret(key: string): Promise<string | undefined> {
    const filePath = resolveSecretsPath();
    const data = readSecretsFile(filePath);
    if (!Object.hasOwn(data.secrets, key)) return undefined;
    return data.secrets[key]?.value;
  }

  checkDomain(key: string, hostname: string): boolean {
    const filePath = resolveSecretsPath();
    const data = readSecretsFile(filePath);
    if (!Object.hasOwn(data.secrets, key)) return false;
    const entry = data.secrets[key];
    if (!entry) return false;
    if (entry.domains.length === 0) return true;
    const h = hostname.trim().toLowerCase().replace(/\.+$/, "");
    if (!h) return false;
    return entry.domains.some((d) => {
      const allowed = d.trim().toLowerCase().replace(/^\.+|\.+$/g, "");
      return Boolean(allowed) && (h === allowed || h.endsWith("." + allowed));
    });
  }

  getDomains(key: string): string[] | null {
    const filePath = resolveSecretsPath();
    const data = readSecretsFile(filePath);
    if (!Object.hasOwn(data.secrets, key)) return null;
    const entry = data.secrets[key];
    return entry ? entry.domains : null;
  }

  async setSecret(key: string, value: string, domains: string[]): Promise<void> {
    if (!key || !key.trim()) throw new Error("Secret key cannot be empty");
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error("Invalid secret key name");
    }
    if (!value) throw new Error("Secret value cannot be empty");

    const filePath = resolveSecretsPath();
    const data = readSecretsFile(filePath);
    const now = new Date().toISOString();
    const existing = Object.hasOwn(data.secrets, key) ? data.secrets[key] : undefined;
    data.secrets[key] = {
      value,
      domains: domains.map((d) => d.toLowerCase().trim().replace(/^\.+|\.+$/g, "")).filter(Boolean),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    writeSecretsFile(filePath, data);
  }

  async listSecrets(): Promise<SecretListEntry[]> {
    const filePath = resolveSecretsPath();
    const data = readSecretsFile(filePath);
    return Object.entries(data.secrets).map(([key, entry]) => ({
      key,
      domains: entry.domains,
      updatedAt: entry.updatedAt,
    }));
  }

  async removeSecret(key: string): Promise<boolean> {
    const filePath = resolveSecretsPath();
    const data = readSecretsFile(filePath);
    if (!Object.hasOwn(data.secrets, key)) return false;
    delete data.secrets[key];
    writeSecretsFile(filePath, data);
    return true;
  }

  getSecretsFilePath(): string {
    return resolveSecretsPath();
  }
}

export const secretStore = new JsonSecretStoreImpl();

class SessionSecretTrackerImpl {
  private trackedNodes = new Map<string, Set<number>>();
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
    if (!value || value.length < 3) return;
    let set = this.sessionSecrets.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this.sessionSecrets.set(sessionId, set);
    }
    set.add(value);
  }

  redact(sessionId: string, text: string): string {
    if (!text || typeof text !== "string") return text;
    const set = this.sessionSecrets.get(sessionId);
    if (!set || set.size === 0) return text;

    let redacted = text;
    for (const secret of set) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
    return redacted;
  }

  redactValue<T>(sessionId: string, val: T, seen: WeakSet<object> = new WeakSet()): T {
    const set = this.sessionSecrets.get(sessionId);
    if (!set || set.size === 0 || val == null) return val;
    if (typeof val === "string") return this.redact(sessionId, val) as T;
    if (typeof val === "object") {
      if (seen.has(val as object)) return "[Circular]" as unknown as T;
      seen.add(val as object);
      if (Array.isArray(val)) return val.map((v) => this.redactValue(sessionId, v, seen)) as T;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        out[k] = this.redactValue(sessionId, v, seen);
      }
      return out as T;
    }
    return val;
  }

  redactAll(text: string): string {
    if (!text || typeof text !== "string") return text;
    let redacted = text;
    for (const set of this.sessionSecrets.values()) {
      for (const secret of set) {
        if (secret && secret.length >= 3) {
          redacted = redacted.split(secret).join("[REDACTED]");
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
