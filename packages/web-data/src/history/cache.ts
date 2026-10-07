// packages/web-data/src/history/cache.ts — the bounded LRU history cache
// (07-history-service.md §§4, 9). Package-private: only `history/service.ts` constructs
// it, and the `/history` barrel never re-exports it. Entries retain a curated success
// payload for exactly 60 seconds keyed by the deterministic model-generation work key.
// Accounting is exact and deterministic under an injected clock: at most 64 entries and
// 64 MiB of charged canonical bytes, evicting expired entries then least-recently-used
// (insertion-order tie-break) before every insert, and skipping any single item that
// cannot fit on its own. Only complete successes are ever inserted (the caller enforces
// this); failures and partial values never reach the cache.

import {
  HISTORY_MAX_CACHE_BYTES,
  HISTORY_MAX_CACHE_ENTRIES,
  HISTORY_TTL_MS,
} from "../wire/common.js";

/** One retained cache entry charging the canonical bytes of a curated success payload. */
interface CacheEntry {
  /** Deterministic model-generation work key. */ readonly key: string;
  /** Model generation the value was bound under. */ readonly generation: number;
  /** Absolute epoch-ms expiry (`insertedAt + 60_000`). */ readonly expiresAt: number;
  /** Charged canonical payload bytes. */ readonly bytes: number;
  /** Immutable retained payload. */ readonly value: unknown;
  /** Monotonic insertion sequence for a deterministic LRU tie-break. */ readonly insertionSeq: number;
  /** Epoch-ms of the most recent read or the insert. */ lastUsedAt: number;
}

/** Instantaneous read-only cache counters surfaced through `HistoryService.stats()`. */
export interface HistoryCacheStats {
  /** Unexpired retained entries. */ readonly cachedKeys: number;
  /** Canonical bytes charged to retained entries. */ readonly cachedBytes: number;
}

/**
 * A deterministic time-to-live + LRU cache for curated history successes. All time comes
 * from the caller's injected clock so expiry and eviction are fully reproducible in tests.
 */
export class HistoryCache {
  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private insertionSeq = 0;

  /** Current unexpired entry count (does not sweep). */
  get size(): number {
    return this.entries.size;
  }

  /** Current charged canonical byte total (does not sweep). */
  get bytes(): number {
    return this.totalBytes;
  }

  /** Instantaneous entry/byte counters. */
  stats(): HistoryCacheStats {
    return { cachedKeys: this.entries.size, cachedBytes: this.totalBytes };
  }

  /** Remove every entry whose expiry is at or before `now`. */
  sweepExpired(now: number): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.expiresAt <= now) this.delete(entry.key);
    }
  }

  /**
   * Return the retained value for an unexpired, generation-matching entry and refresh its
   * LRU recency to `now`; otherwise null. An entry found expired is removed as a side effect.
   */
  get(key: string, generation: number, now: number): unknown | null {
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= now) {
      this.delete(key);
      return null;
    }
    if (entry.generation !== generation) return null;
    entry.lastUsedAt = now;
    return entry.value;
  }

  /**
   * Insert a curated success payload charging `bytes` canonical bytes with a 60-second TTL.
   * Expired entries are swept, then least-recently-used entries are evicted until both the
   * entry-count and byte limits admit the new item. A single item larger than the byte
   * budget is never cached. Replacing an existing key first releases its charge.
   */
  set(key: string, generation: number, value: unknown, bytes: number, now: number): void {
    if (bytes > HISTORY_MAX_CACHE_BYTES) return;
    this.delete(key);
    this.sweepExpired(now);
    while (
      this.entries.size + 1 > HISTORY_MAX_CACHE_ENTRIES ||
      this.totalBytes + bytes > HISTORY_MAX_CACHE_BYTES
    ) {
      const victim = this.leastRecentlyUsedKey();
      if (victim === null) break;
      this.delete(victim);
    }
    if (
      this.entries.size + 1 > HISTORY_MAX_CACHE_ENTRIES ||
      this.totalBytes + bytes > HISTORY_MAX_CACHE_BYTES
    ) {
      return;
    }
    this.insertionSeq += 1;
    this.entries.set(key, {
      key,
      generation,
      expiresAt: now + HISTORY_TTL_MS,
      bytes,
      value,
      insertionSeq: this.insertionSeq,
      lastUsedAt: now,
    });
    this.totalBytes += bytes;
  }

  /** Drop every entry and reset the byte charge to zero. */
  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.totalBytes -= entry.bytes;
  }

  /** The key of the least-recently-used entry, breaking ties by earliest insertion. */
  private leastRecentlyUsedKey(): string | null {
    let best: CacheEntry | null = null;
    for (const entry of this.entries.values()) {
      if (
        best === null ||
        entry.lastUsedAt < best.lastUsedAt ||
        (entry.lastUsedAt === best.lastUsedAt && entry.insertionSeq < best.insertionSeq)
      ) {
        best = entry;
      }
    }
    return best === null ? null : best.key;
  }
}
