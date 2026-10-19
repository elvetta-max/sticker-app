import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { sotdKey, utcDateString } from "../../src/lib/sotd.js";
import { pickStickersOfTheDay } from "../../src/workers/trending.worker.js";

/** In-memory Redis double: cache (GET/SET/DEL) + counters + pipeline. */
function createMemoryRedis() {
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
      kv.set(key, typeof value === "string" ? value : String(value));
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
    async scan() {
      return ["0", []];
    },
    pipeline() {
      const ops = [];
      const chain = {
        del: (key) => {
          ops.push(() => this.del(key));
          return chain;
        },
        zadd: () => chain,
        expire: () => chain,
        exec: async () => {
          for (const op of ops) await op();
          return [];
        },
      };
      return chain;
    },
  };
}

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const now = new Date();

let app;
let prisma;
let redis;
let appId;
let emptyAppId;
let otherAppId;
let recentA;
let recentB;
let oldSticker;
let hiddenSticker;
let recentOnlyAppId;
let recentOnly;

const image = (app_id, name, is_hidden = false, created_at) =>
  prisma.image.create({
    data: {
      app_id,
      is_hidden,
      created_at,
      image_url: `https://example.test/${suffix}/${name}.webp`,
      cloudinary_public_id: `test/${suffix}/${name}`,
    },
  });

beforeAll(async () => {
  prisma = getPrisma();
  redis = createMemoryRedis();

  appId = randomUUID();
  emptyAppId = randomUUID();
  otherAppId = randomUUID();
  recentOnlyAppId = randomUUID();
  for (const [id, name] of [
    [appId, "daily"],
    [emptyAppId, "daily-empty"],
    [otherAppId, "daily-other"],
    [recentOnlyAppId, "daily-recent"],
  ]) {
    await prisma.app.create({
      data: { id, name: `Daily ${name}`, package_name: `test.daily.${name}.${suffix}` },
    });
  }

  recentA = (await image(appId, "a")).id;
  recentB = (await image(appId, "b")).id;
  oldSticker = (await image(appId, "old", false, new Date(now.getTime() - 40 * 24 * 3600 * 1000)))
    .id;
  hiddenSticker = (await image(appId, "hidden", true)).id;
  await image(emptyAppId, "hidden-only", true);
  await image(otherAppId, "other");
  recentOnly = (await image(recentOnlyAppId, "recent")).id;
  await image(recentOnlyAppId, "old", false, new Date(now.getTime() - 40 * 24 * 3600 * 1000));

  app = createApp({ prisma, redis });
});

afterAll(async () => {
  await prisma.app.deleteMany({
    where: { id: { in: [appId, emptyAppId, otherAppId, recentOnlyAppId] } },
  });
  await disconnectPrisma();
});

const daily = (id) => request(app).get(`/api/stickers/daily?app_id=${id}`);

describe("GET /api/stickers/daily", () => {
  it("returns a visible sticker for the tenant and is stable across calls", async () => {
    const first = await daily(appId);
    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);
    expect([recentA, recentB]).toContain(first.body.data.id);
    expect(first.body.data.id).not.toBe(oldSticker);
    expect(first.body.data.id).not.toBe(hiddenSticker);
    expect(first.body.data).toMatchObject({
      id: expect.any(String),
      app_id: appId,
      image_url: expect.any(String),
      tags: expect.any(Array),
    });

    const second = await daily(appId);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(await redis.get(sotdKey(appId, utcDateString()))).toBe(first.body.data.id);
  });

  it("serves the pre-picked sticker from the cache key", async () => {
    await redis.set(sotdKey(appId, utcDateString()), recentB);
    const res = await daily(appId);
    expect(res.body.data.id).toBe(recentB);
  });

  it("recomputes when the stored pick is no longer visible", async () => {
    await redis.set(sotdKey(appId, utcDateString()), hiddenSticker);
    const res = await daily(appId);
    expect(res.status).toBe(200);
    expect(res.body.data.id).not.toBe(hiddenSticker);
    expect([recentA, recentB]).toContain(res.body.data.id);
  });

  it("404s for a tenant with no visible stickers", async () => {
    const res = await daily(emptyAppId);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("STICKER_NOT_FOUND");
  });

  it("isolates tenants and validates the query", async () => {
    const other = await daily(otherAppId);
    expect(other.status).toBe(200);
    expect(other.body.data.app_id).toBe(otherAppId);

    expect((await daily(randomUUID())).status).toBe(404);
    expect((await request(app).get("/api/stickers/daily")).status).toBe(400);
    expect((await request(app).get("/api/stickers/daily?app_id=nope")).status).toBe(400);
  });
});

describe("sticker-of-the-day maintenance job", () => {
  it("only picks stickers created within the recency window", async () => {
    const result = await pickStickersOfTheDay({ prisma, redis, now });
    expect(result.picked).toBeGreaterThanOrEqual(1);
    expect(await redis.get(sotdKey(recentOnlyAppId, utcDateString(now)))).toBe(recentOnly);
  });
});
