import { z } from "zod";

export const MAX_FAVORITES_BATCH = 200;
export const MAX_FAVORITES_LIMIT = 50;
export const DEFAULT_FAVORITES_LIMIT = 20;

/** Body for `POST /api/user/favorites/batch` (context.md §4.5). */
export const favoritesBatchBodySchema = z.object({
  device_id: z.string().trim().min(1).max(128),
  app_id: z.uuid(),
  favorite_image_ids: z.array(z.uuid()).max(MAX_FAVORITES_BATCH),
  action: z.enum(["ADD", "REMOVE"]),
});

/** Query for `GET /api/user/favorites` — re-hydrates the client's local state (§4.5). */
export const favoritesQuerySchema = z.object({
  device_id: z.string().trim().min(1).max(128),
  app_id: z.uuid(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_FAVORITES_LIMIT).default(DEFAULT_FAVORITES_LIMIT),
});
