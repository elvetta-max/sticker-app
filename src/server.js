import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { getPrisma, disconnectPrisma } from "./config/prisma.js";
import { getRedis, disconnectRedis } from "./config/redis.js";
import { queueProviderFrom, registerDependency, registerQueue } from "./lib/metrics.js";
import { getStickerQueue } from "./queues/sticker.queue.js";
import { getNotificationQueue } from "./queues/notification.queue.js";
import { getMaintenanceQueue } from "./queues/maintenance.queue.js";
import { initSentry } from "./lib/sentry.js";

const app = createApp({ logger });

const sentryEnabled = await initSentry();
logger.info({ sentryEnabled }, "sentry error tracking initialized");

// Scrape-time metric sources (context.md §8): queue depth/age + dependency health.
registerQueue("sticker-processing", queueProviderFrom(getStickerQueue()));
registerQueue("notification-dispatch", queueProviderFrom(getNotificationQueue()));
registerQueue("maintenance", queueProviderFrom(getMaintenanceQueue()));

const prismaClient = getPrisma();
const redisClient = getRedis();
registerDependency("database", async () => {
  await prismaClient.$queryRaw`SELECT 1`;
  return true;
});
registerDependency("redis", async () => (await redisClient.ping()) === "PONG");

const server = app.listen(env.PORT, () => {
  logger.info(`api-stiker listening on http://localhost:${env.PORT}`);
});

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}, shutting down...`);
  server.close();
  try {
    await disconnectPrisma();
    await disconnectRedis();
  } catch (err) {
    logger.error({ err }, "error during shutdown");
  } finally {
    process.exit(0);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

export { app, server };
