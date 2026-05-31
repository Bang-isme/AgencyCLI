import { LRUCache } from "lru-cache";

export class MemoryCache<K extends {}, V extends {}> {
  private cache: LRUCache<K, V>;

  constructor(maxSize = 500, ttlMs = 1000 * 60 * 5) {
    this.cache = new LRUCache<K, V>({
      max: maxSize,
      ttl: ttlMs,
    });
  }

  public get(key: K): V | undefined {
    return this.cache.get(key);
  }

  public set(key: K, value: V, ttlMs?: number): void {
    this.cache.set(key, value, { ttl: ttlMs });
  }

  public delete(key: K): void {
    this.cache.delete(key);
  }

  public clear(): void {
    this.cache.clear();
  }

  public size(): number {
    return this.cache.size;
  }
}
