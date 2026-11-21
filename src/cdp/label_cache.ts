interface CacheEntry {
  ref: string;
  timestamp: number;
}

const DEFAULT_TTL_MS = 30_000;

export class LabelCache {
  private maxEntries: number;
  private ttlMs: number;
  private cache: Map<string, CacheEntry>;

  constructor(maxEntries = 200, ttlMs = DEFAULT_TTL_MS) {
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  private getKey(targetId: string, url: string, label: string): string {
    return `${targetId}:::${url}:::${label.toLowerCase().trim()}`;
  }

  public get(targetIdOrUrl: string, urlOrLabel: string, maybeLabel?: string): string | null {
    const key = maybeLabel !== undefined
      ? this.getKey(targetIdOrUrl, urlOrLabel, maybeLabel)
      : this.getKey("default", targetIdOrUrl, urlOrLabel);

    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    if (now - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }

    this.cache.delete(key);
    entry.timestamp = now;
    this.cache.set(key, entry);
    return entry.ref;
  }

  public set(targetIdOrUrl: string, urlOrLabel: string, labelOrRef: string, maybeRef?: string): void {
    const key = maybeRef !== undefined
      ? this.getKey(targetIdOrUrl, urlOrLabel, labelOrRef)
      : this.getKey("default", targetIdOrUrl, urlOrLabel);
    const ref = maybeRef !== undefined ? maybeRef : labelOrRef;

    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { ref, timestamp: Date.now() });
  }

  public invalidate(targetIdOrUrl: string, maybeUrl?: string): void {
    if (maybeUrl !== undefined) {
      const prefix = `${targetIdOrUrl}:::${maybeUrl}:::`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
      return;
    }

    const targetPrefix = `${targetIdOrUrl}:::`;
    const urlMarker = `:::${targetIdOrUrl}:::`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(targetPrefix) || key.includes(urlMarker)) {
        this.cache.delete(key);
      }
    }
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }
}

export const labelCache = new LabelCache();
