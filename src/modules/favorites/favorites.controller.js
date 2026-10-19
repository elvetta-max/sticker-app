import { syncFavorites, listFavorites, FAVORITES_SYNC_MESSAGE } from "./favorites.service.js";

/**
 * POST /api/user/favorites/batch — apply an idempotent ADD/REMOVE batch (context.md §4.5).
 */
export async function postFavoritesBatch(req, res) {
  const { processed_count } = await syncFavorites({
    prisma: req.app.locals.prisma,
    device_id: req.body.device_id,
    app_id: req.body.app_id,
    favorite_image_ids: req.body.favorite_image_ids,
    action: req.body.action,
  });

  res.status(200).json({
    success: true,
    processed_count,
    message: FAVORITES_SYNC_MESSAGE,
  });
}

/**
 * GET /api/user/favorites — list a device's favorites for a tenant (context.md §4.5).
 */
export async function getFavorites(req, res) {
  const { data, next_cursor } = await listFavorites({
    prisma: req.app.locals.prisma,
    device_id: req.query.device_id,
    app_id: req.query.app_id,
    cursor: req.query.cursor,
    limit: req.query.limit,
  });

  res.status(200).json({ success: true, data, next_cursor });
}
