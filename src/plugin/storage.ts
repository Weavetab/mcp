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
  private readonly pluginDir: string;
  private readonly configPath: string;
  private readonly kvStorePath: string;
  private inMemoryKV: Record<string, any> | null = null;

  constructor(public readonly pluginName: string) {
    // Sanitize plugin name for safe filesystem directory creation
    const safeName = pluginName.replace(/[^a-zA-Z0-9_.-]/g, "_");
    this.pluginDir = path.join(GLOBAL_CONFIG_DIR, "plugins", safeName);
    this.configPath = path.join(this.pluginDir, "config.json");
    this.kvStorePath = path.join(this.pluginDir, "storage.json");

    this.ensureDir(this.pluginDir);
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
          return JSON.parse(raw);
        }
      }

      // If config.json doesn't exist yet, save default config
      this.ensureDir(this.pluginDir);
      fs.writeFileSync(this.configPath, JSON.stringify(defaultConfig, null, 2), "utf-8");
      logDebug(`[Weavetab PluginStorage] Created default config for "${this.pluginName}" at: ${this.configPath}`);
      return { ...defaultConfig };
    } catch (e) {
      logDebug(`[Weavetab PluginStorage] Error loading config for "${this.pluginName}":`, e);
      return { ...defaultConfig };
    }
  }

  /**
   * Saves updated configuration to ~/.weavetab/plugins/<plugin-name>/config.json.
   */
  public saveConfig(configData: Record<string, any>): void {
    try {
      this.ensureDir(this.pluginDir);
      fs.writeFileSync(this.configPath, JSON.stringify(configData, null, 2), "utf-8");
    } catch (e) {
      logDebug(`[Weavetab PluginStorage] Error saving config for "${this.pluginName}":`, e);
      throw e;
    }
  }

  private loadKV(): Record<string, any> {
    if (this.inMemoryKV !== null) return this.inMemoryKV;
    try {
      if (fs.existsSync(this.kvStorePath)) {
        const raw = fs.readFileSync(this.kvStorePath, "utf-8").trim();
        this.inMemoryKV = raw ? JSON.parse(raw) : {};
      } else {
        this.inMemoryKV = {};
      }
    } catch {
      this.inMemoryKV = {};
    }
    return this.inMemoryKV || {};
  }

  private persistKV(): void {
    try {
      this.ensureDir(this.pluginDir);
      fs.writeFileSync(this.kvStorePath, JSON.stringify(this.inMemoryKV || {}, null, 2), "utf-8");
    } catch (e) {
      logDebug(`[Weavetab PluginStorage] Failed to persist KV for "${this.pluginName}":`, e);
    }
  }

  public async get<T = any>(key: string, defaultValue?: T): Promise<T | null> {
    const kv = this.loadKV();
    return key in kv ? (kv[key] as T) : defaultValue !== undefined ? defaultValue : null;
  }

  public async set<T = any>(key: string, value: T): Promise<void> {
    const kv = this.loadKV();
    kv[key] = value;
    this.persistKV();
  }

  public async delete(key: string): Promise<boolean> {
    const kv = this.loadKV();
    if (key in kv) {
      delete kv[key];
      this.persistKV();
      return true;
    }
    return false;
  }

  public getPath(subpath: string = ""): string {
    const resolved = path.resolve(this.pluginDir, subpath);
    // Security check: ensure subpath does not escape the plugin directory
    const baseWithSep = this.pluginDir.endsWith(path.sep) ? this.pluginDir : this.pluginDir + path.sep;
    if (resolved !== this.pluginDir && !resolved.startsWith(baseWithSep)) {
      throw new Error(`Security Violation: Path "${subpath}" attempts to escape plugin directory.`);
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
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
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
    this.inMemoryKV = {};
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
