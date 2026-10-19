import { AppError } from "../../lib/errors.js";
import { normalizeKeyword } from "../../lib/normalize.js";
import {
  trendingSearchKey,
  searchPrefixKey,
  SUGGEST_MIN_LENGTH,
  SUGGEST_LIMIT,
} from "../../lib/search.js";
import { parseWithScores } from "../../lib/trending.js";

/**
 * Log a search query (context.md §4.6). The keyword is normalized (§5.2); an empty
 * result is rejected and never stored. The trending ZSET is nudged (`ZINCRBY`) so it
 * stays fresh between 10-minute rebuilds — the aggregation query itself never runs
 * on the request path.
 *
 * @param {{ prisma: any, redis?: any, device_id: string, app_id: string, keyword: string }} args
 * @returns {Promise<{ keyword: string }>} the normalized keyword that was stored
 */
export async function logSearch({ prisma, redis, device_id, app_id, keyword }) {
  const normalized = normalizeKeyword(keyword);
  if (!normalized) {
    throw AppError.validation("Search keyword is empty after normalization.");
  }

  const app = await prisma.app.findUnique({ where: { id: app_id }, select: { id: true } });
  if (!app) {
    throw AppError.notFound("App not found.");
  }

  await prisma.searchQuery.create({
    data: { app_id, device_id, keyword: normalized },
  });

  try {
    if (typeof redis?.zincrby === "function") {
      await redis.zincrby(trendingSearchKey(app_id), 1, normalized);
    }
    if (typeof redis?.zadd === "function" && normalized.length >= SUGGEST_MIN_LENGTH) {
      await redis.zadd(searchPrefixKey(app_id), 0, normalized);
    }
  } catch {
    // best effort — a cache hiccup must never fail the search log
  }

  return { keyword: normalized };
}

/**
 * Pre-aggregated trending searches for an app (context.md §4.6), read from the
 * worker-maintained ZSET in reverse score order.
 *
 * @param {{ prisma: any, redis?: any, app_id: string, limit: number }} args
 * @returns {Promise<{ keyword: string, count: number }[]>}
 */
export async function getTrendingSearches({ prisma, redis, app_id, limit }) {
  const app = await prisma.app.findUnique({ where: { id: app_id }, select: { id: true } });
  if (!app) {
    throw AppError.notFound("App not found.");
  }

  if (typeof redis?.zrevrange !== "function") {
    return [];
  }

  const flat = await redis.zrevrange(trendingSearchKey(app_id), 0, limit - 1, "WITHSCORES");
  return parseWithScores(flat ?? []).map((item) => ({
    keyword: item.id,
    count: Math.round(item.score),
  }));
}

/**
 * Prefix autocomplete for an app (context.md §4.16), read from the worker-maintained
 * lex ZSET (`search:prefix:{app_id}`, members scored 0) via `ZRANGEBYLEX`. The query is
 * normalized the same way as stored keywords; queries shorter than the 2-char minimum
 * (or with no matches) yield an empty list.
 *
 * @param {{ prisma: any, redis?: any, app_id: string, q?: string }} args
 * @returns {Promise<string[]>}
 */
export async function getSearchSuggestions({ prisma, redis, app_id, q }) {
  const app = await prisma.app.findUnique({ where: { id: app_id }, select: { id: true } });
  if (!app) {
    throw AppError.notFound("App not found.");
  }

  const normalized = normalizeKeyword(q ?? "");
  if (normalized.length < SUGGEST_MIN_LENGTH) return [];
  if (typeof redis?.zrangebylex !== "function") return [];

  const matches = await redis.zrangebylex(
    searchPrefixKey(app_id),
    `[${normalized}`,
    `[${normalized}\xff`,
    "LIMIT",
    0,
    SUGGEST_LIMIT,
  );
  return (matches ?? []).slice(0, SUGGEST_LIMIT);
}
