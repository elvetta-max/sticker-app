import { Worker } from "bullmq";
import { redisConnectionOptions } from "../queues/connection.js";
import { MAINTENANCE_QUEUE_NAME, MaintenanceJob } from "../queues/maintenance.queue.js";
import { trendingKey, trendingScore, TRENDING_TTL_SECONDS } from "../lib/trending.js";
import {
  DAY_MS,
  SEARCH_RETENTION_DAYS,
  SEARCH_TRENDING_TTL_SECONDS,
  SEARCH_TRENDING_WINDOW_DAYS,
  SEARCH_SUGGEST_TTL_SECONDS,
  SUGGEST_MIN_LENGTH,
  trendingSearchKey,
  searchPrefixKey,
} from "../lib/search.js";
import { SOTD_TTL_SECONDS, selectDailySticker, sotdKey, utcDateString } from "../lib/sotd.js";

/**
 * Recompute the trending ZSET for a single app into Redis (context.md §5.1).
 * Idempotent: rebuilds the key from scratch, so re-running is always safe.
 *
 * @param {{ prisma: any, redis: any, appId: string, now?: Date }} args
 * @returns {Promise<number>} number of stickers scored
 */
export async function recomputeTrendingForApp({ prisma, redis, appId, now = new Date() }) {
  const images = await prisma.image.findMany({
    where: { app_id: appId, is_hidden: false },
    select: { id: true, downloads: true, shares: true, created_at: true },
  });

  const key = trendingKey(appId);
  const pipeline = redis.pipeline();
  pipeline.del(key);
  for (const image of images) {
    pipeline.zadd(key, trendingScore(image, now), image.id);
  }
  if (images.length > 0) {
    pipeline.expire(key, TRENDING_TTL_SECONDS);
  }
  await pipeline.exec();

  return images.length;
}

/**
 * Recompute trending for every tenant.
 * @param {{ prisma: any, redis: any, now?: Date }} args
 */
export async function recomputeAllTrending({ prisma, redis, now = new Date() }) {
  const apps = await prisma.app.findMany({ select: { id: true } });
  let stickers = 0;
  for (const app of apps) {
    stickers += await recomputeTrendingForApp({ prisma, redis, appId: app.id, now });
  }
  return { apps: apps.length, stickers };
}

/**
 * Rebuild the trending-search ZSETs (`trending:search:{app_id}`) from the last 7
 * days of `SearchQuery` rows (context.md §4.6). Idempotent: each app's key is
 * rebuilt from scratch, and apps with no recent searches have their key cleared.
 *
 * @param {{ prisma: any, redis: any, now?: Date }} args
 */
export async function recomputeSearchTrending({ prisma, redis, now = new Date() }) {
  const cutoff = new Date(now.getTime() - SEARCH_TRENDING_WINDOW_DAYS * DAY_MS);

  const rows = await prisma.searchQuery.groupBy({
    by: ["app_id", "keyword"],
    where: { created_at: { gte: cutoff } },
    _count: { _all: true },
  });

  const byApp = new Map();
  for (const row of rows) {
    if (!byApp.has(row.app_id)) byApp.set(row.app_id, []);
    byApp.get(row.app_id).push({ keyword: row.keyword, count: row._count._all });
  }

  const apps = await prisma.app.findMany({ select: { id: true } });
  let keywords = 0;
  for (const app of apps) {
    const items = byApp.get(app.id) ?? [];
    const key = trendingSearchKey(app.id);
    const pipeline = redis.pipeline();
    pipeline.del(key);
    for (const item of items) {
      pipeline.zadd(key, item.count, item.keyword);
    }
    if (items.length > 0) {
      pipeline.expire(key, SEARCH_TRENDING_TTL_SECONDS);
    }
    await pipeline.exec();
    keywords += items.length;
  }

  return { apps: apps.length, keywords };
}

/**
 * Purge `SearchQuery` rows older than the retention window (context.md §4.6).
 * @param {{ prisma: any, now?: Date }} args
 */
export async function purgeSearchQueries({ prisma, now = new Date() }) {
  const cutoff = new Date(now.getTime() - SEARCH_RETENTION_DAYS * DAY_MS);
  const { count } = await prisma.searchQuery.deleteMany({
    where: { created_at: { lt: cutoff } },
  });
  return { deleted: count };
}

/**
 * Rebuild the autocomplete prefix ZSETs (`search:prefix:{app_id}`) from the last 7
 * days of `SearchQuery` rows (context.md §4.16). Idempotent: each app's key is rebuilt
 * from scratch and apps with no recent searches are cleared. Members score 0 so
 * `ZRANGEBYLEX` yields prefix matches.
 *
 * @param {{ prisma: any, redis: any, now?: Date }} args
 */
export async function recomputeSearchSuggest({ prisma, redis, now = new Date() }) {
  const cutoff = new Date(now.getTime() - SEARCH_TRENDING_WINDOW_DAYS * DAY_MS);

  const rows = await prisma.searchQuery.groupBy({
    by: ["app_id", "keyword"],
    where: { created_at: { gte: cutoff } },
  });

  const byApp = new Map();
  for (const row of rows) {
    if (row.keyword.length < SUGGEST_MIN_LENGTH) continue;
    if (!byApp.has(row.app_id)) byApp.set(row.app_id, new Set());
    byApp.get(row.app_id).add(row.keyword);
  }

  const apps = await prisma.app.findMany({ select: { id: true } });
  let keywords = 0;
  for (const app of apps) {
    const items = [...(byApp.get(app.id) ?? [])].sort();
    const key = searchPrefixKey(app.id);
    const pipeline = redis.pipeline();
    pipeline.del(key);
    for (const keyword of items) {
      pipeline.zadd(key, 0, keyword);
    }
    if (items.length > 0) {
      pipeline.expire(key, SEARCH_SUGGEST_TTL_SECONDS);
    }
    await pipeline.exec();
    keywords += items.length;
  }

  return { apps: apps.length, keywords };
}

/**
 * Pick each tenant's Sticker of the Day and cache the id under `sotd:{app}:{day}`
 * (context.md §4.15). Idempotent and deterministic, so re-running is always safe.
 *
 * @param {{ prisma: any, redis: any, now?: Date }} args
 */
export async function pickStickersOfTheDay({ prisma, redis, now = new Date() }) {
  const date = utcDateString(now);
  const apps = await prisma.app.findMany({ select: { id: true } });

  let picked = 0;
  for (const app of apps) {
    const image = await selectDailySticker({ prisma, appId: app.id, now });
    const key = sotdKey(app.id, date);
    if (image) {
      await redis.set(key, image.id, "EX", SOTD_TTL_SECONDS);
      picked += 1;
    } else {
      await redis.del(key);
    }
  }

  return { apps: apps.length, picked };
}

/**
 * Start the maintenance worker (trending/search rollups + purges).
 * @param {{ prisma: any, redis: any, connection?: object, concurrency?: number }} deps
 */
export function startMaintenanceWorker({ prisma, redis, connection, concurrency = 1 }) {
  return new Worker(
    MAINTENANCE_QUEUE_NAME,
    async (job) => {
      switch (job.name) {
        case MaintenanceJob.TRENDING_RECOMPUTE:
          return recomputeAllTrending({ prisma, redis });
        case MaintenanceJob.SEARCH_TRENDING_RECOMPUTE:
          return recomputeSearchTrending({ prisma, redis });
        case MaintenanceJob.SEARCH_SUGGEST_RECOMPUTE:
          return recomputeSearchSuggest({ prisma, redis });
        case MaintenanceJob.SOTD_PICK:
          return pickStickersOfTheDay({ prisma, redis });
        case MaintenanceJob.SEARCH_PURGE:
          return purgeSearchQueries({ prisma });
        default:
          throw new Error(`Unknown maintenance job: ${job.name}`);
      }
    },
    { connection: connection ?? redisConnectionOptions(), concurrency },
  );
}
