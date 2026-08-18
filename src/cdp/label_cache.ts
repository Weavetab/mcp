// src/cdp/label_cache.ts
// In-memory LRU cache to map labels to Ref IDs to speed up repeated browser_click calls

interface CacheEntry {
  ref: string;
  timestamp: number;
}

class LabelCache {
  private maxEntries: number;
  private cache: Map<string, CacheEntry>;

  constructor(maxEntries = 200) {
    this.maxEntries = maxEntries;
    this.cache = new Map();
  }

  private getKey(url: string, label: string): string {
    return `${url}:::${label}`;
  }

  public get(url: string, label: string): string | null {
    const key = this.getKey(url, label);
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Update timestamp for LRU
    entry.timestamp = Date.now();
    return entry.ref;
  }

  public set(url: string, label: string, ref: string): void {
    const key = this.getKey(url, label);

    if (this.cache.size >= this.maxEntries) {
      this.evict();
    }

    this.cache.set(key, { ref, timestamp: Date.now() });
  }

  public invalidate(url: string): void {
    const prefix = `${url}:::`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  private evict(): void {
    let oldestKey = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.timestamp < oldestTime) {
        oldestTime = entry.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }
}

export const labelCache = new LabelCache();
