import express from "express";
import { pinoHttp } from "pino-http";
import { logger } from "./config/logger.js";
import { getPrisma } from "./config/prisma.js";
import { getRedis } from "./config/redis.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { apiRouter } from "./routes/index.js";
import { metricsMiddleware, registry, renderMetrics } from "./lib/metrics.js";
import { getOpenApiSpec, getSwaggerHtml } from "./lib/openapi.js";

/**
 * Build the Express application.
 *
 * Dependencies are injectable so the app can be tested without live Prisma/Redis.
 *
 * @param {{
 *   prisma?: { $queryRaw: Function },
 *   redis?: { ping: Function, incr?: Function, expire?: Function },
 *   logger?: object,
 *   stickerQueue?: object,
 *   notificationQueue?: object,
 *   flowProducer?: object,
 * }} [deps]
 * @returns {import("express").Express}
 */
export function createApp(deps = {}) {
  const prismaClient = deps.prisma ?? getPrisma();
  const redisClient = deps.redis ?? getRedis();
  const log = deps.logger ?? logger;

  const app = express();
  app.locals.prisma = prismaClient;
  app.locals.redis = redisClient;
  app.locals.stickerQueue = deps.stickerQueue ?? null;
  app.locals.notificationQueue = deps.notificationQueue ?? null;
  app.locals.flowProducer = deps.flowProducer ?? null;

  app.disable("x-powered-by");
  app.use(
    pinoHttp({
      logger: log,
      // Health/readiness probes are high-frequency; keep them out of access logs.
      autoLogging: {
        ignore: (req) => req.url === "/healthz" || req.url === "/readyz" || req.url === "/metrics",
      },
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use(metricsMiddleware);

  app.get("/healthz", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  // Prometheus scrape target (context.md §8). Intentionally outside `/api` so it is
  // never rate-limited or blocked by tenant maintenance mode.
  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", registry.contentType);
    res.status(200).send(await renderMetrics());
  });

  app.get("/readyz", async (_req, res) => {
    const checks = { database: "down", redis: "down" };
    let ready = true;

    try {
      await prismaClient.$queryRaw`SELECT 1`;
      checks.database = "up";
    } catch (err) {
      ready = false;
      log.debug({ err }, "database readiness check failed");
    }

    try {
      const pong = await redisClient.ping();
      if (pong === "PONG") {
        checks.redis = "up";
      } else {
        ready = false;
      }
    } catch (err) {
      ready = false;
      log.debug({ err }, "redis readiness check failed");
    }

    if (ready) {
      return res.status(200).json({ status: "ok", checks });
    }

    return res.status(503).json({
      success: false,
      error: {
        code: "NOT_READY",
        message: "Service dependencies are not ready.",
        details: checks,
      },
    });
  });

  // Interactive API docs (Swagger UI) + the raw OpenAPI document. Outside `/api`
  // so they are never rate-limited or blocked by tenant maintenance mode.
  app.get("/openapi.yaml", (_req, res) => {
    res.type("application/yaml").status(200).send(getOpenApiSpec());
  });

  app.get("/docs", (_req, res) => {
    res.type("text/html").status(200).send(getSwaggerHtml());
  });

  // Public API surface — global rate limit per context.md §6.5 (300 req/min/IP).
  app.use("/api", rateLimit({ windowSeconds: 60, max: 300, keyPrefix: "rl:global" }), apiRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

export default createApp;
