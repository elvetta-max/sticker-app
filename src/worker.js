import { getPrisma, disconnectPrisma } from "./config/prisma.js";
import { getRedis, disconnectRedis } from "./config/redis.js";
import { createCloudinaryAdapter } from "./config/cloudinary.js";
import { startStickerWorker } from "./workers/sticker.worker.js";
import { startMaintenanceWorker } from "./workers/trending.worker.js";
import { startNotificationWorker } from "./workers/notification.worker.js";
import { closeStickerQueue } from "./queues/sticker.queue.js";
import { closeBulkFlowProducer } from "./queues/bulk.queue.js";
import { closeNotificationQueue, getNotificationQueue } from "./queues/notification.queue.js";
import {
  scheduleTrendingRecompute,
  scheduleSearchTrendingRecompute,
  scheduleSearchSuggestRecompute,
  scheduleSotdPick,
  scheduleSearchPurge,
  closeMaintenanceQueue,
} from "./queues/maintenance.queue.js";
import { createFcmSender } from "./lib/fcm.js";
import { captureException, initSentry } from "./lib/sentry.js";
import { logger } from "./config/logger.js";

await initSentry();

const prisma = getPrisma();
const redis = getRedis();
const cloudinary = createCloudinaryAdapter();
const fcmSender = createFcmSender();

const notificationQueue = getNotificationQueue();

const stickerWorker = startStickerWorker({ prisma, cloudinary, redis, notificationQueue });
const maintenanceWorker = startMaintenanceWorker({ prisma, redis });
const notificationWorker = startNotificationWorker({ prisma, sender: fcmSender, redis });

stickerWorker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, name: job.name, result }, "sticker job completed");
});
stickerWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, err }, "sticker job failed");
  captureException(err, {
    job_id: job?.id,
    job_name: job?.name,
    queue: "sticker-processing",
    worker: "sticker",
  });
});
stickerWorker.on("error", (err) => {
  logger.error({ err }, "sticker worker error");
  captureException(err, { worker: "sticker", queue: "sticker-processing" });
});

maintenanceWorker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, name: job.name, result }, "maintenance job completed");
});
maintenanceWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, err }, "maintenance job failed");
  captureException(err, {
    job_id: job?.id,
    job_name: job?.name,
    queue: "maintenance",
    worker: "maintenance",
  });
});
maintenanceWorker.on("error", (err) => {
  logger.error({ err }, "maintenance worker error");
  captureException(err, { worker: "maintenance", queue: "maintenance" });
});

notificationWorker.on("completed", (job, result) => {
  logger.info({ jobId: job.id, name: job.name, result }, "notification job completed");
});
notificationWorker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, name: job?.name, err }, "notification job failed");
  captureException(err, {
    job_id: job?.id,
    job_name: job?.name,
    queue: "notification-dispatch",
    worker: "notification",
  });
});
notificationWorker.on("error", (err) => {
  logger.error({ err }, "notification worker error");
  captureException(err, { worker: "notification", queue: "notification-dispatch" });
});

await scheduleTrendingRecompute();
await scheduleSearchTrendingRecompute();
await scheduleSearchSuggestRecompute();
await scheduleSotdPick();
await scheduleSearchPurge();
await maintenanceWorker.waitUntilReady();
await notificationWorker.waitUntilReady();
logger.info("workers started (sticker + maintenance + notification)");

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}, stopping workers...`);
  try {
    await stickerWorker.close();
    await maintenanceWorker.close();
    await notificationWorker.close();
    await closeStickerQueue();
    await closeBulkFlowProducer();
    await closeMaintenanceQueue();
    await closeNotificationQueue();
    await disconnectRedis();
    await disconnectPrisma();
  } catch (err) {
    logger.error({ err }, "error during worker shutdown");
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export { stickerWorker, maintenanceWorker, notificationWorker };
