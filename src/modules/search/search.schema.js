import { z } from "zod";

export const MAX_TRENDING_LIMIT = 30;
export const DEFAULT_TRENDING_LIMIT = 10;

/** Body for `POST /api/search` (context.md §4.6). */
export const searchLogSchema = z.object({
  device_id: z.string().trim().min(1).max(128),
  app_id: z.uuid(),
  keyword: z.string().min(1).max(64),
});

/** Query for `GET /api/search/trending` (context.md §4.6). */
export const searchTrendingQuerySchema = z.object({
  app_id: z.uuid(),
  limit: z.coerce.number().int().min(1).max(MAX_TRENDING_LIMIT).default(DEFAULT_TRENDING_LIMIT),
});

/** Query for `GET /api/search/suggest` (context.md §4.16). */
export const searchSuggestQuerySchema = z.object({
  app_id: z.uuid(),
  q: z.string().max(64).default(""),
});
