import * as fs from "node:fs";
import * as path from "node:path";
import { GLOBAL_CONFIG_DIR } from "../config/loader.js";
import { logDebug } from "../audit/logger.js";

/**
 * Interface for isolated plugin file and key-value storage.
 */
export interface IPluginStorage {
  get<T = any>(key: string, defaultValue?: T): Promise<T | null>;
  set<T = any>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  getJSON<T = any>(filename: string): Promise<T | null>;
  setJSON<T = any>(filename: string, data: T): Promise<void>;
  getPath(subpath?: string): string;
  list(subpath?: string): Promise<string[]>;
  setWithExpiry<T = any>(key: string, value: T, ttlMs: number): Promise<void>;
  getWithExpiry<T = any>(key: string): Promise<T | null>;
  remember<T = any>(key: string, ttlMs: number, resolver: () => Promise<T>): Promise<T>;
  clear(): Promise<void>;
  pruneExpired(): Promise<number>;
}

/**
 * Creates an isolated storage sandbox for a plugin under:
 * ~/.weavetab/plugins/<plugin-name>/
 */
export class PluginStorageManager implements IPluginStorage {
  private static readonly FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  private readonly pluginDir: string;
  private readonly configPath: string;
  private readonly kvStorePath: string;
  private inMemoryKV: Record<string, any> | null = null;
  private kvMtimeMs = 0;

  constructor(public readonly pluginName: string) {
    const trimmed = (pluginName || "").trim();
    const isScoped = /^@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(trimmed);
    if (
      !trimmed ||
      trimmed === "." ||
      trimmed === ".." ||
      trimmed.includes("..") ||
      trimmed.includes("\\") ||
      (!isScoped && trimmed.includes("/"))
    ) {
      throw new Error(`Security Violation: Invalid plugin name "${pluginName}".`);
    }

    const safeName = trimmed.replace(/[^a-zA-Z0-9_.-]/g, "_").replace(/^\.+/, "_");
    if (!safeName || safeName === "." || safeName === "..") {
      throw new Error(`Security Violation: Invalid plugin name "${pluginName}".`);
    }

    const pluginsRoot = path.resolve(GLOBAL_CONFIG_DIR, "plugins");
    this.pluginDir = path.resolve(pluginsRoot, safeName);
    if (!this.pluginDir.startsWith(pluginsRoot + path.sep)) {
      throw new Error(`Security Violation: Plugin directory "${this.pluginDir}" escapes "${pluginsRoot}".`);
    }
    this.configPath = path.join(this.pluginDir, "config.json");
    this.kvStorePath = path.join(this.pluginDir, "storage.json");

    this.ensureDir(this.pluginDir);
  }

  private assertSafeKey(key: string): void {
    if (PluginStorageManager.FORBIDDEN_KEYS.has(key)) {
      throw new Error(`Security Violation: Forbidden storage key "${key}".`);
    }
  }

  private writeAtomicSync(targetPath: string, content: string): void {
    const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tmpPath, content, "utf-8");
      fs.renameSync(tmpPath, targetPath);
    } catch (e) {
      try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
      throw e;
    }
  }

  /**
   * Returns the absolute path to the plugin's isolated directory.
   */
  public getDirectory(): string {
    return this.pluginDir;
  }

  /**
   * Returns the absolute path to the plugin's config.json.
   */
  public getConfigPath(): string {
    return this.configPath;
  }

  private ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        logDebug(`[Weavetab PluginStorage] Failed to create dir ${dir}:`, e);
      }
    }
  }

  /**
   * Loads the plugin's isolated config.json. If it does not exist and a defaultConfig is provided,
   * writes the default config to ~/.weavetab/plugins/<plugin-name>/config.json.
   */
  public loadConfig(defaultConfig: Record<string, any> = {}): Record<string, any> {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = fs.readFileSync(this.configPath, "utf-8").trim();
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return { ...defaultConfig, ...parsed };
          }
          return parsed;
        }
      }

      this.ensureDir(this.pluginDir);
      this.writeAtomicSync(this.configPath, JSON.stringify(defaultConfig, null, 2));
      logDebug(`[Weavetab PluginStorage] Created default config for "${this.pluginName}" at: ${this.configPath}`);
      return { ...defaultConfig };
    } catch (e) {
      try {
        if (fs.existsSync(this.configPath)) {
          fs.copyFileSync(this.configPath, `${this.configPath}.corrupt.${Date.now()}.bak`);
        }
      } catch {}
      logDebug(`[Weavetab PluginStorage] Error loading config for "${this.pluginName}":`, e);
      return { ...defaultConfig };
    }
  }

  public saveConfig(configData: Record<string, any>): void {
    try {
      this.ensureDir(this.pluginDir);
      this.writeAtomicSync(this.configPath, JSON.stringify(configData, null, 2));
    } catch (e) {
      logDebug(`[Weavetab PluginStorage] Error saving config for "${this.pluginName}":`, e);
      throw e;
    }
  }

  private loadKV(): Record<string, any> {
    try {
      if (fs.existsSync(this.kvStorePath)) {
        const stat = fs.statSync(this.kvStorePath);
        if (this.inMemoryKV !== null && stat.mtimeMs === this.kvMtimeMs) {
          return this.inMemoryKV;
        }
        const raw = fs.readFileSync(this.kvStorePath, "utf-8").trim();
        const next = Object.create(null);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            for (const [k, v] of Object.entries(parsed)) {
              if (!PluginStorageManager.FORBIDDEN_KEYS.has(k)) {
                next[k] = v;
              }
            }
          }
        }
        this.inMemoryKV = next;
        this.kvMtimeMs = stat.mtimeMs;
      } else if (this.inMemoryKV === null) {
        this.inMemoryKV = Object.create(null);
        this.kvMtimeMs = 0;
      }
    } catch {
      try {
        if (fs.existsSync(this.kvStorePath)) {
          fs.copyFileSync(this.kvStorePath, `${this.kvStorePath}.corrupt.${Date.now()}.bak`);
        }
      } catch {}
      this.inMemoryKV = Object.create(null);
      this.kvMtimeMs = 0;
    }
    return this.inMemoryKV!;
  }

  private persistKV(): void {
    try {
      this.ensureDir(this.pluginDir);
      this.writeAtomicSync(this.kvStorePath, JSON.stringify(this.inMemoryKV || {}, null, 2));
      if (fs.existsSync(this.kvStorePath)) {
        this.kvMtimeMs = fs.statSync(this.kvStorePath).mtimeMs;
      }
    } catch (e) {
      logDebug(`[Weavetab PluginStorage] Failed to persist KV for "${this.pluginName}":`, e);
    }
  }

  public async get<T = any>(key: string, defaultValue?: T): Promise<T | null> {
    if (PluginStorageManager.FORBIDDEN_KEYS.has(key)) {
      return defaultValue !== undefined ? defaultValue : null;
    }
    const kv = this.loadKV();
    return Object.hasOwn(kv, key) ? (kv[key] as T) : defaultValue !== undefined ? defaultValue : null;
  }

  public async set<T = any>(key: string, value: T): Promise<void> {
    this.assertSafeKey(key);
    const kv = this.loadKV();
    kv[key] = value;
    this.persistKV();
  }

  public async delete(key: string): Promise<boolean> {
    if (PluginStorageManager.FORBIDDEN_KEYS.has(key)) return false;
    const kv = this.loadKV();
    if (Object.hasOwn(kv, key)) {
      delete kv[key];
      this.persistKV();
      return true;
    }
    return false;
  }

  public getPath(subpath: string = ""): string {
    const baseResolved = path.resolve(this.pluginDir);
    const resolved = path.resolve(baseResolved, subpath);
    const baseWithSep = baseResolved.endsWith(path.sep) ? baseResolved : baseResolved + path.sep;
    if (resolved !== baseResolved && !resolved.startsWith(baseWithSep)) {
      throw new Error(`Security Violation: Path "${subpath}" attempts to escape plugin directory.`);
    }
    if (fs.existsSync(baseResolved)) {
      const realBase = fs.realpathSync(baseResolved);
      const realBaseWithSep = realBase.endsWith(path.sep) ? realBase : realBase + path.sep;
      let cur = resolved;
      while (!fs.existsSync(cur)) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        cur = parent;
      }
      if (fs.existsSync(cur)) {
        const realCur = fs.realpathSync(cur);
        if (realCur !== realBase && !realCur.startsWith(realBaseWithSep)) {
          throw new Error(`Security Violation: Path "${subpath}" attempts to escape plugin directory via symlink.`);
        }
      }
    }
    return resolved;
  }

  public async getJSON<T = any>(filename: string): Promise<T | null> {
    const filePath = this.getPath(filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(raw) as T;
    } catch (e) {
      logDebug(`[Weavetab PluginStorage] Error reading JSON from "${filePath}":`, e);
      return null;
    }
  }

  public async setJSON<T = any>(filename: string, data: T): Promise<void> {
    const filePath = this.getPath(filename);
    const parent = path.dirname(filePath);
    this.ensureDir(parent);
    this.writeAtomicSync(filePath, JSON.stringify(data, null, 2));
  }

  public async setWithExpiry<T = any>(key: string, value: T, ttlMs: number): Promise<void> {
    const record = { val: value, exp: Date.now() + ttlMs };
    await this.set(`__ttl_${key}`, record);
  }

  public async getWithExpiry<T = any>(key: string): Promise<T | null> {
    const record = await this.get<{ val: T; exp: number }>(`__ttl_${key}`);
    if (!record) return null;
    if (Date.now() > record.exp) {
      await this.delete(`__ttl_${key}`);
      return null;
    }
    return record.val;
  }

  public async remember<T = any>(key: string, ttlMs: number, resolver: () => Promise<T>): Promise<T> {
    const cached = await this.getWithExpiry<T>(key);
    if (cached !== null) return cached;
    const fresh = await resolver();
    await this.setWithExpiry(key, fresh, ttlMs);
    return fresh;
  }

  public async clear(): Promise<void> {
    this.inMemoryKV = Object.create(null);
    this.persistKV();
  }

  public async pruneExpired(): Promise<number> {
    const kv = this.loadKV();
    let pruned = 0;
    const now = Date.now();
    for (const k of Object.keys(kv)) {
      if (k.startsWith('__ttl_') && kv[k]?.exp && now > kv[k].exp) {
        delete kv[k];
        pruned++;
      }
    }
    if (pruned > 0) this.persistKV();
    return pruned;
  }

  public async list(subpath: string = ""): Promise<string[]> {
    const targetDir = this.getPath(subpath);
    if (!fs.existsSync(targetDir)) return [];
    try {
      return fs.readdirSync(targetDir);
    } catch {
      return [];
    }
  }
}
