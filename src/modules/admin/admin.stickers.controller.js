import {
  enqueueStickerUpload,
  updateSticker,
  deleteSticker,
  setStickerHidden,
} from "./admin.stickers.service.js";
import { getStickerQueue } from "../../queues/sticker.queue.js";
import { AuditAction, AuditTarget, recordAudit } from "../../lib/audit.js";

/**
 * POST /api/admin/stickers — accepts a multipart image, enqueues processing and
 * returns 202 with a job id (context.md §4.8).
 */
export async function createSticker(req, res) {
  const queue = req.app.locals.stickerQueue ?? getStickerQueue();
  const body = req.body;

  const job = await enqueueStickerUpload(queue, {
    app_id: body.app_id,
    image_base64: req.file.buffer.toString("base64"),
    is_animated: body.is_animated,
    is_premium: body.is_premium,
    emojis: body.emojis,
    tags: body.tags,
  });

  await recordAudit({
    prisma: req.app.locals.prisma,
    actor: req.admin,
    action: AuditAction.STICKER_CREATE,
    target_type: AuditTarget.JOB,
    target_id: job.id,
    app_id: body.app_id,
  });

  res.status(202).json({ success: true, job_id: job.id });
}

/**
 * PUT /api/admin/stickers/{id} (context.md §4.9).
 */
export async function putSticker(req, res) {
  const queue = req.app.locals.stickerQueue ?? getStickerQueue();
  const result = await updateSticker({
    prisma: req.app.locals.prisma,
    queue,
    redis: req.app.locals.redis,
    id: req.params.id,
    body: req.body,
    file: req.file,
  });

  if (result.kind === "job") {
    await recordAudit({
      prisma: req.app.locals.prisma,
      actor: req.admin,
      action: AuditAction.STICKER_REPLACE,
      target_type: AuditTarget.STICKER,
      target_id: req.params.id,
      app_id: result.app_id,
    });
    return res.status(202).json({ success: true, job_id: result.job_id });
  }

  await recordAudit({
    prisma: req.app.locals.prisma,
    actor: req.admin,
    action: AuditAction.STICKER_UPDATE,
    target_type: AuditTarget.STICKER,
    target_id: req.params.id,
    app_id: result.sticker.app_id,
  });
  return res.status(200).json({ success: true, data: result.sticker });
}

/**
 * DELETE /api/admin/stickers/{id} (context.md §4.10).
 */
export async function removeSticker(req, res) {
  const queue = req.app.locals.stickerQueue ?? getStickerQueue();
  const { app_id } = await deleteSticker({
    prisma: req.app.locals.prisma,
    queue,
    redis: req.app.locals.redis,
    id: req.params.id,
  });

  await recordAudit({
    prisma: req.app.locals.prisma,
    actor: req.admin,
    action: AuditAction.STICKER_DELETE,
    target_type: AuditTarget.STICKER,
    target_id: req.params.id,
    app_id,
  });

  res.status(200).json({ success: true, message: "Sticker deleted successfully." });
}

/** Shared handler for the hide/unhide soft-delete pair (context.md §4.14). */
async function setHidden(req, res, hidden) {
  const data = await setStickerHidden({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    id: req.params.id,
    hidden,
  });

  await recordAudit({
    prisma: req.app.locals.prisma,
    actor: req.admin,
    action: hidden ? AuditAction.STICKER_HIDE : AuditAction.STICKER_UNHIDE,
    target_type: AuditTarget.STICKER,
    target_id: req.params.id,
    app_id: data.app_id,
  });

  res.status(200).json({ success: true, data });
}

/** POST /api/admin/stickers/{id}/hide */
export function hideSticker(req, res) {
  return setHidden(req, res, true);
}

/** POST /api/admin/stickers/{id}/unhide */
export function unhideSticker(req, res) {
  return setHidden(req, res, false);
}
