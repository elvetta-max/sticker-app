import { StickerJob } from "../../queues/sticker.queue.js";
import { AppError, ErrorCodes } from "../../lib/errors.js";
import { evictKeys, stickerCachePatterns } from "../../lib/cache.js";
import { toStickerDto } from "../stickers/sticker.mapper.js";

/**
 * Enqueue an async sticker-upload job (context.md §4.8). The heavy Sharp/Cloudinary
 * work happens in the worker, never on the request path.
 *
 * @param {import("bullmq").Queue} queue
 * @param {{ app_id: string, image_base64: string, is_animated: boolean,
 *   is_premium: boolean, emojis: string[], tags: string[] }} payload
 */
export function enqueueStickerUpload(queue, payload) {
  return queue.add(StickerJob.UPLOAD, payload);
}

/**
 * Update a sticker (context.md §4.9).
 * - With a new image: enqueue the replace job (worker swaps the Cloudinary asset).
 * - Metadata-only: update in a single transaction, replacing tags when provided.
 *
 * @param {{ prisma: any, queue: any, redis: any, id: string, body: object, file?: any }} args
 * @returns {Promise<{ kind: "job", job_id: string, app_id: string } | { kind: "updated", sticker: object }>}
 */
export async function updateSticker({ prisma, queue, redis, id, body, file }) {
  const existing = await prisma.image.findUnique({ where: { id }, include: { tags: true } });
  if (!existing) {
    throw new AppError(ErrorCodes.STICKER_NOT_FOUND, "Sticker not found.", 404);
  }

  if (file) {
    const job = await queue.add(StickerJob.REPLACE, {
      image_id: id,
      image_base64: file.buffer.toString("base64"),
      is_animated: body.is_animated ?? existing.is_animated,
      is_premium: body.is_premium ?? existing.is_premium,
      emojis: body.emojis ?? existing.emojis,
      tags: body.tags ?? existing.tags.map((tag) => tag.name),
    });
    return { kind: "job", job_id: job.id, app_id: existing.app_id };
  }

  const data = {};
  if (body.is_premium !== undefined) data.is_premium = body.is_premium;
  if (body.is_animated !== undefined) data.is_animated = body.is_animated;
  if (body.emojis !== undefined) data.emojis = body.emojis;

  const updated = await prisma.$transaction(async (tx) => {
    if (body.tags !== undefined) {
      const tagRecords = await Promise.all(
        body.tags.map((name) => tx.tag.upsert({ where: { name }, update: {}, create: { name } })),
      );
      data.tags = { set: tagRecords.map((tag) => ({ id: tag.id })) };
    }
    return tx.image.update({
      where: { id },
      data,
      include: { tags: { select: { name: true } } },
    });
  });

  await evictKeys(redis, stickerCachePatterns(existing.app_id, id));
  return { kind: "updated", sticker: toStickerDto(updated) };
}

/**
 * Soft-delete / restore a sticker (context.md §4.14). Hiding is instant and
 * reversible: the row stays (so it remains reviewable) but is excluded from every
 * public surface, and the app's caches are evicted immediately.
 *
 * @param {{ prisma: any, redis: any, id: string, hidden: boolean }} args
 */
export async function setStickerHidden({ prisma, redis, id, hidden }) {
  const existing = await prisma.image.findUnique({
    where: { id },
    select: { id: true, app_id: true },
  });
  if (!existing) {
    throw new AppError(ErrorCodes.STICKER_NOT_FOUND, "Sticker not found.", 404);
  }

  const updated = await prisma.image.update({
    where: { id },
    data: { is_hidden: hidden },
    select: { id: true, app_id: true, is_hidden: true },
  });

  await evictKeys(redis, stickerCachePatterns(existing.app_id, id));
  return updated;
}

/**
 * Hard-delete a sticker (context.md §4.10): remove the row (cascades favorites/reports),
 * enqueue Cloudinary asset destruction, and evict the app's cached lists.
 *
 * @param {{ prisma: any, queue: any, redis: any, id: string }} args
 */
export async function deleteSticker({ prisma, queue, redis, id }) {
  const existing = await prisma.image.findUnique({ where: { id } });
  if (!existing) {
    throw new AppError(ErrorCodes.STICKER_NOT_FOUND, "Sticker not found.", 404);
  }

  await prisma.image.delete({ where: { id } });
  await queue.add(StickerJob.DELETE_ASSET, {
    cloudinary_public_id: existing.cloudinary_public_id,
  });
  await evictKeys(redis, stickerCachePatterns(existing.app_id, id));

  return { app_id: existing.app_id };
}
