import { z } from "zod";
import { Worker, UnrecoverableError } from "bullmq";
import { AppError } from "../lib/errors.js";
import { processStickerImage } from "../lib/image.js";
import { trendingKey, trendingDelta } from "../lib/trending.js";
import { evictKeys, feedCachePattern, singleStickerCacheKey } from "../lib/cache.js";
import { redisConnectionOptions } from "../queues/connection.js";
import { STICKER_QUEUE_NAME, StickerJob } from "../queues/sticker.queue.js";
import { NotificationJob } from "../queues/notification.queue.js";

const baseMetadata = {
  is_premium: z.boolean().optional().default(false),
  emojis: z.array(z.string().min(1)).max(20).optional().default([]),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional().default([]),
};

export const uploadJobSchema = z.object({
  app_id: z.uuid(),
  image_base64: z.string().min(1),
  is_animated: z.boolean().optional().default(false),
  ...baseMetadata,
});

export const replaceJobSchema = z.object({
  image_id: z.uuid(),
  image_base64: z.string().min(1),
  is_animated: z.boolean().optional().default(false),
  is_premium: baseMetadata.is_premium,
  emojis: baseMetadata.emojis,
  tags: baseMetadata.tags,
});

export const deleteAssetJobSchema = z.object({
  cloudinary_public_id: z.string().min(1),
});

export const incrementCounterJobSchema = z.object({
  image_id: z.uuid(),
  app_id: z.uuid(),
  field: z.enum(["downloads", "shares"]),
});

/**
 * Parent bulk job payload (context.md §4.17). Children carry the actual images; the
 * parent only records the filename ↔ child-job-id mapping so it can aggregate results.
 */
export const bulkJobSchema = z.object({
  app_id: z.uuid(),
  total: z.number().int().min(0),
  entries: z.array(
    z.object({
      filename: z.string().min(1),
      job_id: z.string().min(1),
    }),
  ),
});

/**
 * Upsert tags by name and create the Image row atomically.
 * @param {any} prisma
 * @param {{ app_id: string, url: string, publicId: string, is_animated: boolean,
 *   is_premium: boolean, emojis: string[], tags: string[] }} data
 */
async function createImageWithTags(prisma, data) {
  return prisma.$transaction(async (tx) => {
    const tagRecords = await Promise.all(
      data.tags.map((name) => tx.tag.upsert({ where: { name }, update: {}, create: { name } })),
    );

    return tx.image.create({
      data: {
        app_id: data.app_id,
        image_url: data.url,
        cloudinary_public_id: data.publicId,
        is_animated: data.is_animated,
        is_premium: data.is_premium,
        emojis: data.emojis,
        tags: { connect: tagRecords.map((tag) => ({ id: tag.id })) },
      },
    });
  });
}

/**
 * Enqueue the event-driven `SEARCH_MATCH` push for a newly created sticker
 * (context.md §4.11). Best effort: a queue hiccup must never fail the upload.
 *
 * @param {{ image_id: string, app_id: string, tags: string[] }} args
 * @param {{ notificationQueue?: { add: Function } }} deps
 */
async function enqueueSearchMatch({ image_id, app_id, tags }, { notificationQueue }) {
  if (!notificationQueue || !Array.isArray(tags) || tags.length === 0) return;
  try {
    await notificationQueue.add(
      NotificationJob.SEARCH_MATCH,
      { image_id, app_id },
      { jobId: `search-match-${image_id}` },
    );
  } catch {
    // best effort — the sticker is already live, so never fail the upload
  }
}

/** @param {any} data @param {{ prisma: any, cloudinary: any, redis?: any, notificationQueue?: any }} deps */
async function handleUpload(data, { prisma, cloudinary, redis, notificationQueue }) {
  const payload = uploadJobSchema.parse(data);

  const app = await prisma.app.findUnique({
    where: { id: payload.app_id },
    select: { id: true },
  });
  if (!app) {
    throw new AppError("NOT_FOUND", `Unknown app ${payload.app_id}.`, 404);
  }

  const processed = await processStickerImage(Buffer.from(payload.image_base64, "base64"), {
    isAnimated: payload.is_animated,
  });
  const asset = await cloudinary.uploadSticker({
    buffer: processed.buffer,
    appId: payload.app_id,
  });

  const image = await createImageWithTags(prisma, {
    app_id: payload.app_id,
    url: asset.url,
    publicId: asset.publicId,
    is_animated: processed.is_animated,
    is_premium: payload.is_premium,
    emojis: payload.emojis,
    tags: payload.tags,
  });

  // New sticker changes the app's feed pages (context.md §6.3).
  await evictKeys(redis, [feedCachePattern(image.app_id)]);

  // Event-driven search-match push for devices that asked for one of these tags.
  await enqueueSearchMatch(
    { image_id: image.id, app_id: image.app_id, tags: payload.tags },
    { notificationQueue },
  );

  return {
    image_id: image.id,
    image_url: image.image_url,
    cloudinary_public_id: image.cloudinary_public_id,
  };
}

/** @param {any} data @param {{ prisma: any, cloudinary: any, redis?: any }} deps */
async function handleReplace(data, { prisma, cloudinary, redis }) {
  const payload = replaceJobSchema.parse(data);

  const existing = await prisma.image.findUnique({ where: { id: payload.image_id } });
  if (!existing) {
    throw new AppError("NOT_FOUND", `Unknown sticker ${payload.image_id}.`, 404);
  }

  const processed = await processStickerImage(Buffer.from(payload.image_base64, "base64"), {
    isAnimated: payload.is_animated,
  });
  const asset = await cloudinary.uploadSticker({
    buffer: processed.buffer,
    appId: existing.app_id,
  });

  const updated = await prisma.$transaction(async (tx) => {
    const tagRecords = await Promise.all(
      payload.tags.map((name) => tx.tag.upsert({ where: { name }, update: {}, create: { name } })),
    );

    return tx.image.update({
      where: { id: payload.image_id },
      data: {
        image_url: asset.url,
        cloudinary_public_id: asset.publicId,
        is_animated: processed.is_animated,
        is_premium: payload.is_premium,
        emojis: payload.emojis,
        tags: { set: tagRecords.map((tag) => ({ id: tag.id })) },
      },
    });
  });

  // Only remove the previous asset once the new one is committed.
  await cloudinary.destroySticker(existing.cloudinary_public_id);

  // The row's image_url changed — drop its feed pages and cached DTO (§6.3).
  await evictKeys(redis, [feedCachePattern(updated.app_id), singleStickerCacheKey(updated.id)]);

  return { image_id: updated.id, image_url: updated.image_url };
}

/** @param {any} data @param {{ cloudinary: any }} deps */
async function handleDeleteAsset(data, { cloudinary }) {
  const payload = deleteAssetJobSchema.parse(data);
  await cloudinary.destroySticker(payload.cloudinary_public_id);
  return { deleted: payload.cloudinary_public_id };
}

/**
 * Increment a sticker's download/share counter (context.md §4.4) and nudge the
 * trending ZSET so it stays fresh between 5-minute recomputes (§5.1). Runs off the
 * request path; the endpoint responds optimistically.
 *
 * @param {any} data
 * @param {{ prisma: any, redis?: any }} deps
 */
async function handleIncrementCounter(data, { prisma, redis }) {
  const payload = incrementCounterJobSchema.parse(data);

  const image = await prisma.image.update({
    where: { id: payload.image_id },
    data: { [payload.field]: { increment: 1 } },
    select: { id: true, app_id: true, downloads: true, shares: true, created_at: true },
  });

  if (redis) {
    await redis.zincrby(
      trendingKey(image.app_id),
      trendingDelta({ created_at: image.created_at }, payload.field),
      image.id,
    );
  }

  return { image_id: image.id, downloads: image.downloads, shares: image.shares };
}

/**
 * Aggregate a bulk parent job's children into the progress contract of context.md
 * §4.17: `{ total, completed, failed, results: [{ filename, status, sticker_id? | error? }] }`.
 * Works on any job-like object exposing `getChildrenValues()` /
 * `getFailedChildrenValues()` (both keyed by qualified child job key).
 *
 * @param {{ job: { getChildrenValues: Function, getFailedChildrenValues: Function }, data: any }} args
 */
export async function summarizeBulkJob({ job, data }) {
  const payload = bulkJobSchema.parse(data);
  const [values, failures] = await Promise.all([
    job.getChildrenValues(),
    job.getFailedChildrenValues(),
  ]);

  const byId = (key) => String(key).split(":").pop();
  const completed = new Map(Object.entries(values ?? {}).map(([key, value]) => [byId(key), value]));
  const failed = new Map(Object.entries(failures ?? {}).map(([key, value]) => [byId(key), value]));

  const results = payload.entries.map((entry) => {
    const success = completed.get(entry.job_id);
    if (success) {
      return { filename: entry.filename, status: "completed", sticker_id: success.image_id };
    }
    const error = failed.get(entry.job_id);
    return {
      filename: entry.filename,
      status: "failed",
      error: typeof error === "string" ? error : (error?.message ?? "Processing failed."),
    };
  });

  const completedCount = results.filter((r) => r.status === "completed").length;
  return {
    total: payload.total,
    completed: completedCount,
    failed: results.length - completedCount,
    results,
  };
}

/**
 * Pure job processor — the unit of work, independent of BullMQ so it can be tested directly.
 * @param {{ name: string, data: unknown }} job
 * @param {{ prisma: any, cloudinary: any, redis?: any }} deps
 */
export async function processStickerJob(job, deps) {
  switch (job.name) {
    case StickerJob.UPLOAD:
      return handleUpload(job.data, deps);
    case StickerJob.REPLACE:
      return handleReplace(job.data, deps);
    case StickerJob.DELETE_ASSET:
      return handleDeleteAsset(job.data, deps);
    case StickerJob.INCREMENT_COUNTER:
      return handleIncrementCounter(job.data, deps);
    default:
      throw new Error(`Unknown sticker job: ${job.name}`);
  }
}

/**
 * Start a BullMQ worker that consumes the sticker queue.
 * Validation/processing errors (4xx) are marked unrecoverable so BullMQ does not
 * waste retries; transient (5xx) errors are retried with exponential backoff.
 *
 * @param {{ prisma: any, cloudinary: any, redis?: any, notificationQueue?: any,
 *   connection?: object, concurrency?: number }} deps
 */
export function startStickerWorker({
  prisma,
  cloudinary,
  redis,
  notificationQueue,
  connection,
  concurrency = 2,
}) {
  const worker = new Worker(
    STICKER_QUEUE_NAME,
    async (job) => {
      try {
        if (job.name === StickerJob.BULK) {
          return await summarizeBulkJob({ job, data: job.data });
        }
        return await processStickerJob(job, { prisma, cloudinary, redis, notificationQueue });
      } catch (err) {
        if (err instanceof AppError && err.status < 500) {
          throw new UnrecoverableError(err.message);
        }
        throw err;
      }
    },
    { connection: connection ?? redisConnectionOptions(), concurrency },
  );
  return worker;
}
