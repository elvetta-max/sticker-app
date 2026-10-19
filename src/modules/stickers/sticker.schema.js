import { z } from "zod";
import { normalizeKeyword } from "../../lib/normalize.js";

export const MAX_FEED_LIMIT = 50;
export const DEFAULT_FEED_LIMIT = 20;

/**
 * Query schema for `GET /api/stickers`.
 */
export const stickerListQuerySchema = z
  .object({
    app_id: z.uuid(),
    limit: z.coerce.number().int().min(1).max(MAX_FEED_LIMIT).default(DEFAULT_FEED_LIMIT),
    cursor: z.string().min(1).max(512).optional(),
    sort_by: z.enum(["latest", "trending"]).default("latest"),
    search: z.string().max(64).optional(),
  })
  .transform((query) => {
    const search = query.search ? normalizeKeyword(query.search) : "";
    return { ...query, search: search.length > 0 ? search : undefined };
  });

/** Params for `GET /api/stickers/{id}`. */
export const stickerIdParamsSchema = z.object({
  id: z.uuid(),
});

/** Query for `GET /api/stickers/{id}` — required tenant scope. */
export const stickerGetQuerySchema = z.object({
  app_id: z.uuid(),
});

/** Query for `GET /api/stickers/daily` — required tenant scope (context.md §4.15). */
export const stickerDailyQuerySchema = z.object({
  app_id: z.uuid(),
});

/** Params for the engagement trackers (`POST /api/stickers/{id}/download|share`). */
export const stickerEngagementParamsSchema = z.object({
  id: z.uuid(),
});

/** Body for the engagement trackers (context.md §4.4). */
export const stickerEngagementBodySchema = z.object({
  app_id: z.uuid(),
  device_id: z.string().min(1).max(128),
});

/** Allowed moderation report reasons (context.md §4.14). */
export const REPORT_REASONS = ["inappropriate", "copyright", "spam", "other"];

/** Params for `POST /api/stickers/{id}/report`. */
export const stickerReportParamsSchema = z.object({
  id: z.uuid(),
});

/** Body for `POST /api/stickers/{id}/report` (context.md §4.14). */
export const stickerReportBodySchema = z.object({
  device_id: z.string().trim().min(1).max(128),
  reason: z.enum(REPORT_REASONS),
});
