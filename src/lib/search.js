/** Search-trending constants (context.md §4.6). */
export const DAY_MS = 24 * 60 * 60 * 1000;

/** ZSET rebuilt by the maintenance worker every 10 minutes. */
export const SEARCH_TRENDING_REBUILD_MS = 10 * 60 * 1000;

/** Longer than the rebuild interval so a missed run does not empty the list. */
export const SEARCH_TRENDING_TTL_SECONDS = 20 * 60;

/** Aggregation window for trending searches: last 7 days. */
export const SEARCH_TRENDING_WINDOW_DAYS = 7;

/** `SearchQuery` rows older than this are purged daily (context.md §2.3). */
export const SEARCH_RETENTION_DAYS = 15;

/** Daily purge at 03:00 UTC. */
export const SEARCH_PURGE_CRON = "0 3 * * *";

/** Autocomplete prefix ZSET is rebuilt by the maintenance worker every 10 minutes. */
export const SEARCH_SUGGEST_REBUILD_MS = 10 * 60 * 1000;

/** Longer than the rebuild interval so a missed run does not empty suggestions. */
export const SEARCH_SUGGEST_TTL_SECONDS = 20 * 60;

/** Minimum normalized query length before prefix suggestions are attempted. */
export const SUGGEST_MIN_LENGTH = 2;

/** Autocomplete returns at most this many suggestions (context.md §4.16). */
export const SUGGEST_LIMIT = 8;

/** @param {string} appId */
export function trendingSearchKey(appId) {
  return `trending:search:${appId}`;
}

/**
 * Lex-ordered ZSET of normalized keyword suggestions for an app (context.md §4.16).
 * Members all score 0 so `ZRANGEBYLEX` performs true prefix matching.
 * @param {string} appId
 */
export function searchPrefixKey(appId) {
  return `search:prefix:${appId}`;
}
