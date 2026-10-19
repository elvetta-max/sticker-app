import { createHash } from "node:crypto";

/**
 * Cache helpers (context.md §6.3). All keys are app-scoped; short TTLs; reads are
 * best-effort (a cache failure must never fail a request).
 *
 * Key scheme:
 * - feed page   -> `stickers:{app_id}:{hash(query)}`      (TTL 60s)
 * - single item -> `sticker:{id}`                          (TTL 300s)
 * - ad config   -> `ads:{app_id}`                          (TTL 60s)   [later step]
 * - app version -> `version:{app_id}`                      (TTL 60s)   [later step]
 */

export const CacheTtl = Object.freeze({
  feed: 60,
  singleSticker: 300,
  ads: 60,
  version: 60,
  maintenance: 60,
});

/** Cache clients must support GET/SET to participate (lightweight test doubles don't). */
function isCacheCapable(redis) {
  return Boolean(redis && typeof redis.get === "function" && typeof redis.set === "function");
}

/**
 * Deterministic cache key for a feed page.
 * @param {string} appId
 * @param {{ sort_by?: string, limit?: number, cursor?: string, search?: string }} query
 */
export function feedCacheKey(appId, query = {}) {
  const canonical = [
    query.sort_by ?? "latest",
    query.limit ?? "",
    query.cursor ?? "",
    query.search ?? "",
  ].join("|");
  const hash = createHash("sha1").update(canonical).digest("hex").slice(0, 32);
  return `stickers:${appId}:${hash}`;
}

/** @param {string} id */
export function singleStickerCacheKey(id) {
  return `sticker:${id}`;
}

/** Ad configuration key (used by the ads endpoint, later step). @param {string} appId */
export function adsCacheKey(appId) {
  return `ads:${appId}`;
}

/** App version key (used by the version endpoint, later step). @param {string} appId */
export function versionCacheKey(appId) {
  return `version:${appId}`;
}

/**
 * Per-tenant maintenance flag key (context.md §4.18). Kept separate from
 * `version:{app_id}` so the public maintenance guard is one cheap key read.
 * @param {string} appId
 */
export function maintenanceCacheKey(appId) {
  return `maintenance:${appId}`;
}

/** Glob pattern matching every cached feed page for an app. @param {string} appId */
export function feedCachePattern(appId) {
  return `stickers:${appId}:*`;
}

/**
 * @param {any} redis
 * @param {string} key
 * @returns {Promise<unknown | undefined>} parsed value, or undefined on miss/error.
 */
export async function getCachedJson(redis, key) {
  if (!isCacheCapable(redis)) return undefined;
  try {
    const raw = await redis.get(key);
    if (raw == null) return undefined;
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * @param {any} redis
 * @param {string} key
 * @param {unknown} value
 * @param {number} ttlSeconds
 */
export async function setCachedJson(redis, key, value, ttlSeconds) {
  if (!isCacheCapable(redis)) return;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  } catch {
    // best effort — never fail the request because the cache is unavailable
  }
}

const inflight = new Map();

/**
 * Per-key in-memory single-flight guard so a cache miss/expiry under load triggers
 * one loader call, not a stampede.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function singleFlight(key, fn) {
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = Promise.resolve()
    .then(fn)
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/** Test hook: drop all in-flight loaders. */
export function clearSingleFlight() {
  inflight.clear();
}

/**
 * Read-through cache: return the cached JSON value, otherwise load it (single-flight),
 * store it with `ttlSeconds`, and return it.
 *
 * @template T
 * @param {{ redis: any, key: string, ttlSeconds: number, loader: () => Promise<T> }} args
 * @returns {Promise<T>}
 */
export async function readThroughCache({ redis, key, ttlSeconds, loader }) {
  const cached = await getCachedJson(redis, key);
  if (cached !== undefined) return cached;

  return singleFlight(key, async () => {
    const again = await getCachedJson(redis, key);
    if (again !== undefined) return again;
    const value = await loader();
    await setCachedJson(redis, key, value, ttlSeconds);
    return value;
  });
}

/**
 * Delete every key matching the given glob patterns using SCAN (never KEYS).
 * No-ops when the client does not support SCAN (e.g. lightweight test doubles).
 *
 * @param {any} redis
 * @param {string[]} patterns
 * @returns {Promise<number>} number of keys deleted
 */
export async function evictKeys(redis, patterns) {
  if (!redis || typeof redis.scan !== "function" || typeof redis.del !== "function") {
    return 0;
  }

  let deleted = 0;
  for (const pattern of patterns) {
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
      cursor = next;
      if (keys.length > 0) {
        deleted += await redis.del(...keys);
      }
    } while (cursor !== "0");
  }
  return deleted;
}

/**
 * Cache key patterns for a single sticker + its app (context.md §6.3).
 * @param {string} appId
 * @param {string} stickerId
 * @returns {string[]}
 */
export function stickerCachePatterns(appId, stickerId) {
  return [`stickers:${appId}:*`, `trending:stickers:${appId}`, `sticker:${stickerId}`];
}
