import {
  listStickers,
  getSticker,
  getStickerOfTheDay,
  trackEngagement,
  reportSticker,
} from "./sticker.service.js";
import { getStickerQueue } from "../../queues/sticker.queue.js";

/**
 * GET /api/stickers
 */
export async function getStickers(req, res) {
  const { data, next_cursor } = await listStickers({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    query: req.query,
  });

  res.status(200).json({ success: true, data, next_cursor });
}

/**
 * GET /api/stickers/daily — the shared sticker of the day (context.md §4.15).
 */
export async function getDailySticker(req, res) {
  const sticker = await getStickerOfTheDay({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    app_id: req.query.app_id,
  });

  res.status(200).json({ success: true, data: sticker });
}

/**
 * GET /api/stickers/{id}
 */
export async function getStickerById(req, res) {
  const sticker = await getSticker({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    id: req.params.id,
    app_id: req.query.app_id,
  });

  res.status(200).json({ success: true, data: sticker });
}

/**
 * Shared handler for the engagement trackers (`/download`, `/share`).
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {"download"|"share"} action
 */
async function track(req, res, action) {
  const queue = req.app.locals.stickerQueue ?? getStickerQueue();
  const result = await trackEngagement({
    prisma: req.app.locals.prisma,
    queue,
    id: req.params.id,
    app_id: req.body.app_id,
    action,
  });

  res.status(200).json({ success: true, ...result });
}

/** POST /api/stickers/{id}/download */
export function trackDownload(req, res) {
  return track(req, res, "download");
}

/** POST /api/stickers/{id}/share */
export function trackShare(req, res) {
  return track(req, res, "share");
}

/**
 * POST /api/stickers/{id}/report — file a content report (context.md §4.14).
 * Always responds generically so moderation state is never leaked.
 */
export async function postReport(req, res) {
  await reportSticker({
    prisma: req.app.locals.prisma,
    id: req.params.id,
    device_id: req.body.device_id,
    reason: req.body.reason,
  });

  res.status(200).json({ success: true });
}
