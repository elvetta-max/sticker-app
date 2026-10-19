import { AppError, ErrorCodes } from "../../lib/errors.js";
import {
  decodeCursor,
  encodeCursor,
  decodeScoreCursor,
  encodeScoreCursor,
} from "../../lib/cursor.js";
import { trendingKey, paginateScored, parseWithScores } from "../../lib/trending.js";
import {
  CacheTtl,
  feedCacheKey,
  singleStickerCacheKey,
  readThroughCache,
  getCachedJson,
  setCachedJson,
  singleFlight,
} from "../../lib/cache.js";
import { StickerJob } from "../../queues/sticker.queue.js";
import { SOTD_TTL_SECONDS, selectDailySticker, sotdKey, utcDateString } from "../../lib/sotd.js";
import { toStickerDto } from "./sticker.mapper.js";

/** Maps the public action to the counter column it tracks. */
const ENGAGEMENT_FIELD = Object.freeze({ download: "downloads", share: "shares" });

/**
 * List visible stickers for an app, cursor-paginated (context.md §4.2).
 * Dispatches to the trending reader when `sort_by=trending`.
 *
 * @param {{
 *   prisma: import("@prisma/client").PrismaClient,
 *   redis: any,
 *   query: { app_id: string, limit: number, cursor?: string, search?: string, sort_by: string },
 * }} args
 */
export async function listStickers({ prisma, redis, query }) {
  if (query.sort_by === "trending") {
    return listTrending({ prisma, redis, query });
  }
  return listLatest({ prisma, redis, query });
}

/**
 * Newest-first feed backed by the `(app_id, created_at)` index, served through a
 * 60s read-through cache keyed by the full query (context.md §6.3). Cached payloads
 * are tenant-scoped by construction (the key includes `app_id`).
 *
 * @param {{ prisma: any, redis: any, query: any }} args
 */
async function listLatest({ prisma, redis, query }) {
  const key = feedCacheKey(query.app_id, query);
  return readThroughCache({
    redis,
    key,
    ttlSeconds: CacheTtl.feed,
    loader: () => loadLatest({ prisma, query }),
  });
}

/**
 * Uncached loader for the latest feed (also used as the cache loader).
 * @param {{ prisma: any, query: any }} args
 */
async function loadLatest({ prisma, query }) {
  const { app_id, limit, cursor, search } = query;

  const app = await prisma.app.findUnique({ where: { id: app_id }, select: { id: true } });
  if (!app) {
    throw AppError.notFound("App not found.");
  }

  const conditions = [{ app_id, is_hidden: false }];

  if (search) {
    conditions.push({
      tags: { some: { name: { contains: search, mode: "insensitive" } } },
    });
  }

  if (cursor) {
    const { createdAt, id } = decodeCursor(cursor);
    conditions.push({
      OR: [
        { created_at: { lt: createdAt } },
        { AND: [{ created_at: createdAt }, { id: { lt: id } }] },
      ],
    });
  }

  const rows = await prisma.image.findMany({
    where: { AND: conditions },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { tags: { select: { name: true } } },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

  return { data: page.map(toStickerDto), next_cursor: nextCursor };
}

/**
 * Trending feed served from the worker-maintained Redis ZSET snapshot
 * (`trending:stickers:{app_id}`), paginated by the `(score, id)` cursor (§5.1).
 * Never runs an aggregation query on the request path.
 *
 * @param {{ prisma: any, redis: any, query: any }} args
 */
export async function listTrending({ prisma, redis, query }) {
  const { app_id, limit, search, cursor } = query;

  const app = await prisma.app.findUnique({ where: { id: app_id }, select: { id: true } });
  if (!app) {
    throw AppError.notFound("App not found.");
  }

  const decoded = cursor ? decodeScoreCursor(cursor) : undefined;
  const flat = await redis.zrevrangebyscore(
    trendingKey(app_id),
    decoded ? decoded.score : "+inf",
    "-inf",
    "WITHSCORES",
  );
  const { page, next } = paginateScored(parseWithScores(flat ?? []), { cursor: decoded, limit });

  const ids = page.map((item) => item.id);
  let data = [];
  if (ids.length > 0) {
    const conditions = [{ id: { in: ids } }, { app_id }, { is_hidden: false }];
    if (search) {
      conditions.push({ tags: { some: { name: { contains: search, mode: "insensitive" } } } });
    }
    const images = await prisma.image.findMany({
      where: { AND: conditions },
      include: { tags: { select: { name: true } } },
    });
    const byId = new Map(images.map((image) => [image.id, image]));
    data = ids
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map(toStickerDto);
  }

  return { data, next_cursor: next ? encodeScoreCursor(next) : null };
}

/**
 * Fetch a single visible sticker, scoped to a tenant (context.md §4.3), served
 * through a 300s cache (§6.3). A sticker from another tenant, a hidden sticker, or
 * a missing id all resolve to the same STICKER_NOT_FOUND response.
 *
 * The cached DTO carries its owning `app_id`; a cross-tenant request is rejected by
 * comparison even on a cache hit, so the cache never leaks between tenants.
 *
 * @param {{
 *   prisma: import("@prisma/client").PrismaClient,
 *   redis?: any,
 *   id: string,
 *   app_id: string,
 * }} args
 */
export async function getSticker({ prisma, redis, id, app_id }) {
  const key = singleStickerCacheKey(id);

  const cached = await getCachedJson(redis, key);
  if (cached !== undefined) {
    if (cached.app_id !== app_id) {
      throw new AppError(ErrorCodes.STICKER_NOT_FOUND, "Sticker not found.", 404);
    }
    return cached;
  }

  const sticker = await singleFlight(key, async () => {
    const image = await prisma.image.findFirst({
      where: { id, is_hidden: false },
      include: { tags: { select: { name: true } } },
    });
    return image ? toStickerDto(image) : null;
  });

  if (!sticker || sticker.app_id !== app_id) {
    throw new AppError(ErrorCodes.STICKER_NOT_FOUND, "Sticker not found.", 404);
  }

  await setCachedJson(redis, key, sticker, CacheTtl.singleSticker);
  return sticker;
}

/**
 * Track a download/share (context.md §4.4). Verifies the sticker belongs to the
 * tenant, then enqueues the counter increment so the request path never blocks on
 * a DB write. The response is optimistic (`current_* = stored + 1`); the worker
 * applies the increment and nudges the trending ZSET.
 *
 * @param {{
 *   prisma: any,
 *   queue: { add: Function },
 *   id: string,
 *   app_id: string,
 *   action: "download"|"share",
 * }} args
 */
export async function trackEngagement({ prisma, queue, id, app_id, action }) {
  const field = ENGAGEMENT_FIELD[action];

  const image = await prisma.image.findFirst({
    where: { id, app_id, is_hidden: false },
    select: { id: true, app_id: true, downloads: true, shares: true },
  });
  if (!image) {
    throw new AppError(ErrorCodes.STICKER_NOT_FOUND, "Sticker not found.", 404);
  }

  await queue.add(StickerJob.INCREMENT_COUNTER, {
    image_id: image.id,
    app_id: image.app_id,
    field,
  });

  const current = image[field] + 1;
  return action === "download" ? { current_downloads: current } : { current_shares: current };
}

/**
 * File a content report against a visible sticker (context.md §4.14).
 *
 * Idempotent per device: `@@unique([device_id, image_id])` means a repeat report
 * bumps the existing row's `created_at` (and refreshes the reason) instead of
 * creating duplicates that would spam the moderation queue. The response is always
 * generic so moderation state is never leaked. The report's tenant is derived from
 * the sticker, so cross-tenant ids can't be reported.
 *
 * @param {{ prisma: any, id: string, device_id: string, reason: string }} args
 * @returns {Promise<{ success: true }>}
 */
export async function reportSticker({ prisma, id, device_id, reason }) {
  const image = await prisma.image.findFirst({
    where: { id, is_hidden: false },
    select: { id: true, app_id: true },
  });
  if (!image) {
    throw new AppError(ErrorCodes.STICKER_NOT_FOUND, "Sticker not found.", 404);
  }

  const now = new Date();
  await prisma.report.upsert({
    where: { device_id_image_id: { device_id, image_id: id } },
    create: { app_id: image.app_id, device_id, image_id: id, reason, status: "OPEN" },
    update: { reason, created_at: now },
  });

  return { success: true };
}

/**
 * Sticker of the Day for a tenant (context.md §4.15). The worker pre-picks a sticker
 * at 00:05 UTC into `sotd:{app_id}:{day}` (deterministic, shared by every user). On a
 * cold cache the endpoint computes the same deterministic pick and caches it, so the
 * result is stable even before the worker's first run. A pick that has since been
 * hidden/removed is recomputed against the current visible set.
 *
 * @param {{ prisma: any, redis?: any, app_id: string, now?: Date }} args
 * @returns {Promise<object>} the same DTO shape as `GET /api/stickers/{id}`
 */
export async function getStickerOfTheDay({ prisma, redis, app_id, now = new Date() }) {
  const app = await prisma.app.findUnique({ where: { id: app_id }, select: { id: true } });
  if (!app) {
    throw AppError.notFound("App not found.");
  }

  const key = sotdKey(app_id, utcDateString(now));
  const loadVisible = (id) =>
    prisma.image.findFirst({
      where: { id, app_id, is_hidden: false },
      include: { tags: { select: { name: true } } },
    });

  const cachedId = typeof redis?.get === "function" ? await redis.get(key) : null;
  let image = cachedId ? await loadVisible(cachedId) : null;

  if (!image) {
    const picked = await singleFlight(key, () =>
      selectDailySticker({ prisma, appId: app_id, now }),
    );
    if (!picked) {
      throw new AppError(ErrorCodes.STICKER_NOT_FOUND, "Sticker not found.", 404);
    }
    if (typeof redis?.set === "function") {
      await redis.set(key, picked.id, "EX", SOTD_TTL_SECONDS);
    }
    image = await loadVisible(picked.id);
  }

  if (!image) {
    throw new AppError(ErrorCodes.STICKER_NOT_FOUND, "Sticker not found.", 404);
  }
  return toStickerDto(image);
}
