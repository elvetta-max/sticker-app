import { Queue } from "bullmq";
import { redisConnectionOptions } from "./connection.js";

export const STICKER_QUEUE_NAME = "sticker-processing";

/** Job names handled by the sticker worker. */
export const StickerJob = Object.freeze({
  UPLOAD: "sticker:upload",
  REPLACE: "sticker:replace",
  DELETE_ASSET: "sticker:delete-asset",
  INCREMENT_COUNTER: "sticker:increment-counter",
  BULK: "sticker:bulk",
});

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

let queue = null;

/** @returns {Queue} lazily-created singleton producer queue. */
export function getStickerQueue() {
  queue ??= new Queue(STICKER_QUEUE_NAME, {
    connection: redisConnectionOptions(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return queue;
}

/**
 * Enqueue a sticker job.
 * @param {string} name one of {@link StickerJob}
 * @param {object} data
 */
export function enqueueStickerJob(name, data) {
  return getStickerQueue().add(name, data);
}

export async function closeStickerQueue() {
  if (!queue) return;
  const q = queue;
  queue = null;
  await q.close();
}
