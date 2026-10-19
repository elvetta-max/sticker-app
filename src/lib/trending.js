/** Trending ZSET rebuild cadence (context.md §5.1): every 5 minutes. */
export const TRENDING_REBUILD_MS = 5 * 60 * 1000;

/** ZSET TTL: longer than the rebuild interval so a missed run does not empty feeds. */
export const TRENDING_TTL_SECONDS = 10 * 60;

/**
 * Per-action contribution to the trending score (context.md §5.1). Downloads are
 * the primary sticker action (add-to-WhatsApp) and weigh 3× over shares.
 */
export const ENGAGEMENT_WEIGHTS = Object.freeze({ downloads: 3.0, shares: 1.0 });

/** @param {string} appId */
export function trendingKey(appId) {
  return `trending:stickers:${appId}`;
}

/** Age in hours (never negative) between an image's `created_at` and `now`. */
function ageHours(created_at, now) {
  const createdMs = new Date(created_at).getTime();
  return Math.max(0, (now.getTime() - createdMs) / 3_600_000);
}

/**
 * Gravity-style trending score (context.md §5.1):
 *
 *   score = (downloads * 3.0 + shares * 1.0) / POW(age_hours + 2.0, 1.5)
 *
 * Downloads weigh 3× shares (product decision). The +2h floor prevents brand-new
 * items from dividing by zero; the 1.5 exponent makes legacy items decay fast.
 *
 * @param {{ downloads?: number, shares?: number, created_at: Date|string }} image
 * @param {Date} [now]
 * @returns {number}
 */
export function trendingScore({ downloads = 0, shares = 0, created_at }, now = new Date()) {
  const engagement = downloads * ENGAGEMENT_WEIGHTS.downloads + shares * ENGAGEMENT_WEIGHTS.shares;
  return engagement / Math.pow(ageHours(created_at, now) + 2.0, 1.5);
}

/**
 * Score delta contributed by a single counter increment (`ZINCRBY` on the trending
 * set, so it stays fresh between 5-minute recomputes). Uses the same gravity decay
 * as {@link trendingScore}.
 *
 * @param {{ created_at: Date|string }} image
 * @param {"downloads"|"shares"} field
 * @param {Date} [now]
 * @returns {number}
 */
export function trendingDelta({ created_at }, field, now = new Date()) {
  const weight = ENGAGEMENT_WEIGHTS[field] ?? 0;
  return weight / Math.pow(ageHours(created_at, now) + 2.0, 1.5);
}

/**
 * Ordering test for a stable ZSET snapshot paginated with a (score, id) cursor.
 * ZREVRANGE returns equal-score members in reverse-lexicographic order, so an item
 * comes "after" the cursor when its score is lower, or (same score) its id sorts
 * lexicographically lower.
 *
 * @param {{ score: number, id: string }} item
 * @param {{ score: number, id: string } | undefined} cursor
 */
export function isAfterCursor(item, cursor) {
  if (!cursor) return true;
  if (item.score < cursor.score) return true;
  if (item.score > cursor.score) return false;
  return item.id < cursor.id;
}

/**
 * @param {{ score: number, id: string }[]} items
 * @param {{ cursor?: { score: number, id: string }, limit: number }} options
 */
export function paginateScored(items, { cursor, limit }) {
  const rest = items.filter((item) => isAfterCursor(item, cursor));
  const hasMore = rest.length > limit;
  const page = hasMore ? rest.slice(0, limit) : rest;
  const last = page.at(-1);
  const next = hasMore && last ? { score: last.score, id: last.id } : null;
  return { page, hasMore, next };
}

/**
 * Parse the flat `[member, score, member, score, ...]` reply of
 * `ZREVRANGEBYSCORE ... WITHSCORES`.
 * @param {unknown[]} flat
 * @returns {{ id: string, score: number }[]}
 */
export function parseWithScores(flat) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    out.push({ id: String(flat[i]), score: Number(flat[i + 1]) });
  }
  return out;
}
