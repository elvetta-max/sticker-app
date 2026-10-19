import { getAppVersion, getAppAds } from "./app.service.js";

/**
 * GET /api/apps/{app_id}/version — public, Redis-cached update info (context.md §4.12).
 */
export async function getVersion(req, res) {
  const data = await getAppVersion({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    app_id: req.params.app_id,
    current_version: req.query.current_version,
  });

  res.status(200).json({ success: true, ...data });
}

/**
 * GET /api/apps/{app_id}/ads — public, Redis-cached ad config (context.md §4.13).
 */
export async function getAds(req, res) {
  const data = await getAppAds({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    app_id: req.params.app_id,
  });

  res.status(200).json({ success: true, ...data });
}
