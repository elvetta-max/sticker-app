import { Queue } from "bullmq";
import { redisConnectionOptions } from "./connection.js";

export const NOTIFICATION_QUEUE_NAME = "notification-dispatch";

/** Jobs handled by the notification worker. */
export const NotificationJob = Object.freeze({
  BROADCAST: "notification:broadcast",
  SEARCH_MATCH: "notification:search-match",
});

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 5000 },
};

let queue = null;

/** @returns {Queue} lazily-created singleton producer queue. */
export function getNotificationQueue() {
  queue ??= new Queue(NOTIFICATION_QUEUE_NAME, {
    connection: redisConnectionOptions(),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  return queue;
}

export async function closeNotificationQueue() {
  if (!queue) return;
  const q = queue;
  queue = null;
  await q.close();
}
