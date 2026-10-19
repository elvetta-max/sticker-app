import { describe, it, expect } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";

/**
 * In-memory Redis double: rate limiter (INCR/EXPIRE) + cache (GET/SET/SCAN/DEL) + ping.
 * Same pattern as tests/integration/maintenance.test.js.
 */
function createFakeRedis() {
  const kv = new Map();
  const counts = new Map();
  return {
    async ping() {
      return "PONG";
    },
    async get(key) {
      return kv.has(key) ? kv.get(key) : null;
    },
    async set(key, value) {
      kv.set(key, typeof value === "string" ? value : JSON.stringify(value));
      return "OK";
    },
    async incr(key) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
    async del(...keys) {
      let removed = 0;
      for (const key of keys) if (kv.delete(key)) removed += 1;
      return removed;
    },
    async scan(_cursor, _match, pattern) {
      const regex = new RegExp(
        `^${String(pattern)
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")}$`,
      );
      return ["0", [...kv.keys()].filter((key) => regex.test(key))];
    },
  };
}

/** Minimal Prisma double: no live DB needed for /healthz, /metrics or the 404 path. */
function createFakePrisma({ maintenance = false } = {}) {
  return {
    app: {
      findUnique: async () => ({ maintenance_mode: maintenance }),
    },
    image: {
      findFirst: async () => null,
      findUnique: async () => null,
    },
  };
}

function buildApp(options) {
  return createApp({ prisma: createFakePrisma(options), redis: createFakeRedis() });
}

describe("GET /metrics", () => {
  it("serves Prometheus text including requests already handled", async () => {
    const app = buildApp();

    await request(app).get("/healthz").expect(200);

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.text).toContain("http_requests_total");
    expect(res.text).toContain('http_requests_total{method="GET",route="/healthz",status="200"} 1');
  });

  it("labels a real dynamic route with its route pattern", async () => {
    const app = buildApp();
    const appId = randomUUID();

    const sticker = await request(app).get(`/api/stickers/${randomUUID()}?app_id=${appId}`);
    expect(sticker.status).toBe(404);
    expect(sticker.body.error.code).toBe("STICKER_NOT_FOUND");

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.text).toContain('route="/api/stickers/:id"');
    expect(res.text).not.toMatch(/route="\/api\/stickers\/[0-9a-f-]{36}"/);
  });

  it("labels unknown paths as unmatched", async () => {
    const app = buildApp();

    const missing = await request(app).get("/definitely-not-a-route");
    expect(missing.status).toBe(404);

    const res = await request(app).get("/metrics");

    expect(res.status).toBe(200);
    expect(res.text).toContain('route="unmatched"');
  });

  it("is not /api-scoped, so it stays available during tenant maintenance", async () => {
    const app = buildApp({ maintenance: true });
    const appId = randomUUID();

    const blocked = await request(app).get(`/api/stickers/${randomUUID()}?app_id=${appId}`);
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe("MAINTENANCE_MODE");

    const res = await request(app).get("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
  });
});
