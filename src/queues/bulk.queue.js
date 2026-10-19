import { randomUUID } from "node:crypto";
import { FlowProducer } from "bullmq";
import { redisConnectionOptions } from "./connection.js";
import { STICKER_QUEUE_NAME, StickerJob } from "./sticker.queue.js";

/** ZIP upload limits (context.md §4.17). */
export const BULK_MAX_ZIP_BYTES = 50 * 1024 * 1024;
export const BULK_MAX_IMAGES = 200;

/** MIME type accepted for the bulk archive. */
export const BULK_ZIP_MIME = "application/zip";

let flowProducer = null;

/**
 * Lazily-created singleton {@link FlowProducer} used to create the parent bulk job
 * with one child upload job per extracted image (context.md §4.17).
 * @returns {FlowProducer}
 */
export function getBulkFlowProducer() {
  flowProducer ??= new FlowProducer({ connection: redisConnectionOptions() });
  return flowProducer;
}

/**
 * Enqueue a bulk upload as a BullMQ flow: one parent `sticker:bulk` job aggregating
 * one `sticker:upload` child per image. Children reuse the exact single-upload
 * pipeline; `ignoreDependencyOnFailure` lets the parent run and report partial
 * success even when some images fail (context.md §4.17).
 *
 * @param {{
 *   flowProducer: { add: Function },
 *   app_id: string,
 *   is_animated: boolean,
 *   is_premium: boolean,
 *   emojis: string[],
 *   tags: string[],
 *   entries: { filename: string, buffer: Buffer }[],
 * }} args
 * @returns {Promise<{ id: string }>}
 */
export async function enqueueBulkUpload({
  flowProducer,
  app_id,
  is_animated,
  is_premium,
  emojis,
  tags,
  entries,
}) {
  const parentJobId = `bulk-${randomUUID()}`;
  const prepared = entries.map((entry) => ({
    filename: entry.filename,
    job_id: `bulk-child-${randomUUID()}`,
    image_base64: entry.buffer.toString("base64"),
  }));

  const tree = {
    name: StickerJob.BULK,
    queueName: STICKER_QUEUE_NAME,
    opts: {
      jobId: parentJobId,
      attempts: 1,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 5000 },
    },
    data: {
      app_id,
      total: prepared.length,
      is_animated,
      is_premium,
      emojis,
      tags,
      entries: prepared.map(({ filename, job_id }) => ({ filename, job_id })),
    },
    children: prepared.map((entry) => ({
      name: StickerJob.UPLOAD,
      queueName: STICKER_QUEUE_NAME,
      data: {
        app_id,
        image_base64: entry.image_base64,
        is_animated,
        is_premium,
        emojis,
        tags,
      },
      opts: {
        jobId: entry.job_id,
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        ignoreDependencyOnFailure: true,
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    })),
  };

  const added = await flowProducer.add(tree);
  return { id: added.job?.id ?? parentJobId };
}

export async function closeBulkFlowProducer() {
  if (!flowProducer) return;
  const producer = flowProducer;
  flowProducer = null;
  await producer.close();
}
