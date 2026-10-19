import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { rateLimit } from "../../src/middleware/rateLimit.js";
import { errorHandler, notFound } from "../../src/middleware/errorHandler.js";

function memoryRedis() {
  const store = new Map();
  return {
    async incr(key) {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
  };
}

function buildApp(redis, { max = 2, failOpen = true } = {}) {
  const app = express();
  app.locals.redis = redis;
  app.use(rateLimit({ windowSeconds: 60, max, keyPrefix: "test", failOpen }));
  app.get("/x", (_req, res) => res.json({ ok: true }));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe("rateLimit middleware", () => {
  it("allows requests under the limit and sets headers", async () => {
    const app = buildApp(memoryRedis());
    const res = await request(app).get("/x");
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("2");
    expect(res.headers["x-ratelimit-remaining"]).toBe("1");
  });

  it("blocks requests over the limit with a 429 envelope", async () => {
    const app = buildApp(memoryRedis());
    await request(app).get("/x");
    await request(app).get("/x");
    const res = await request(app).get("/x");

    expect(res.status).toBe(429);
    expect(res.body).toEqual({
      success: false,
      error: { code: "RATE_LIMITED", message: expect.any(String) },
    });
    expect(res.headers["retry-after"]).toBe("60");
  });

  it("fails open when the store errors", async () => {
    const broken = {
      incr: async () => {
        throw new Error("redis down");
      },
      expire: async () => 1,
    };
    const res = await request(buildApp(broken)).get("/x");
    expect(res.status).toBe(200);
  });

  it("fails closed when configured", async () => {
    const broken = {
      incr: async () => {
        throw new Error("redis down");
      },
      expire: async () => 1,
    };
    const res = await request(buildApp(broken, { failOpen: false })).get("/x");
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("NOT_READY");
  });

  it("scopes counters with a custom key generator (per-device buckets)", async () => {
    const app = express();
    app.locals.redis = memoryRedis();
    app.use(
      rateLimit({
        windowSeconds: 60,
        max: 1,
        keyPrefix: "dev",
        keyGenerator: (req) => req.get("x-device") ?? "anon",
      }),
    );
    app.get("/x", (_req, res) => res.json({ ok: true }));
    app.use(notFound);
    app.use(errorHandler);

    expect((await request(app).get("/x").set("x-device", "a")).status).toBe(200);
    expect((await request(app).get("/x").set("x-device", "a")).status).toBe(429);
    // A different device has its own bucket and is unaffected.
    expect((await request(app).get("/x").set("x-device", "b")).status).toBe(200);
  });
});
