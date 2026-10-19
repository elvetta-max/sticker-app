import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { evictKeys, feedCachePattern, singleStickerCacheKey } from "../../src/lib/cache.js";

/** In-memory Redis double: strings, INCR counters and SCAN (for eviction). */
function createMemoryRedis() {
  const kv = new Map();
  const counts = new Map();
  const glob = (pattern) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);

  return {
    async ping() {
      return "PONG";
    },
    async get(key) {
      return kv.has(key) ? kv.get(key) : null;
    },
    async set(key, value) {
      kv.set(key, value);
      return "OK";
    },
    async del(...keys) {
      let removed = 0;
      for (const key of keys) {
        if (kv.delete(key)) removed += 1;
      }
      return removed;
    },
    async scan(_cursor, _match, pattern) {
      return ["0", [...kv.keys()].filter((key) => glob(pattern).test(key))];
    },
    async incr(key) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
  };
}

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);

let app;
let prisma;
let redis;
let appId;
let otherAppId;
let imageA;
let imageB;
let otherImage;

beforeAll(async () => {
  prisma = getPrisma();
  redis = createMemoryRedis();
  appId = randomUUID();
  otherAppId = randomUUID();

  await prisma.app.create({
    data: { id: appId, name: "Cache Test App", package_name: `test.cache.${suffix}` },
  });
  await prisma.app.create({
    data: { id: otherAppId, name: "Cache Other App", package_name: `test.cache.other.${suffix}` },
  });

  imageA = await prisma.image.create({
    data: {
      app_id: appId,
      image_url: `https://example.test/${suffix}/a.webp`,
      cloudinary_public_id: `test/${suffix}/a`,
      created_at: new Date("2026-01-02T00:00:00.000Z"),
    },
  });
  imageB = await prisma.image.create({
    data: {
      app_id: appId,
      image_url: `https://example.test/${suffix}/b.webp`,
      cloudinary_public_id: `test/${suffix}/b`,
      created_at: new Date("2026-01-01T00:00:00.000Z"),
    },
  });
  otherImage = await prisma.image.create({
    data: {
      app_id: otherAppId,
      image_url: `https://example.test/${suffix}/other.webp`,
      cloudinary_public_id: `test/${suffix}/other`,
    },
  });

  app = createApp({ prisma, redis });
});

afterAll(async () => {
  await prisma.image.deleteMany({ where: { app_id: { in: [appId, otherAppId] } } });
  await prisma.app.deleteMany({ where: { id: { in: [appId, otherAppId] } } });
  await disconnectPrisma();
});

describe("feed page cache", () => {
  it("serves a cached page until the app's feed cache is evicted", async () => {
    const first = await request(app).get(`/api/stickers?app_id=${appId}`);
    expect(first.body.data).toHaveLength(2);

    // Mutate the DB out-of-band (simulating any write): the cached page still serves.
    await prisma.image.update({ where: { id: imageA.id }, data: { is_hidden: true } });
    const cached = await request(app).get(`/api/stickers?app_id=${appId}`);
    expect(cached.body.data).toHaveLength(2);

    await evictKeys(redis, [feedCachePattern(appId)]);
    const fresh = await request(app).get(`/api/stickers?app_id=${appId}`);
    expect(fresh.body.data).toHaveLength(1);
    expect(fresh.body.data[0].id).toBe(imageB.id);
  });

  it("keys feed pages per tenant", async () => {
    const mine = await request(app).get(`/api/stickers?app_id=${appId}`);
    const theirs = await request(app).get(`/api/stickers?app_id=${otherAppId}`);
    expect(mine.body.data.map((s) => s.id)).toEqual([imageB.id]);
    expect(theirs.body.data.map((s) => s.id)).toEqual([otherImage.id]);
  });
});

describe("single sticker cache", () => {
  it("serves the cached DTO until its key is evicted", async () => {
    const first = await request(app).get(`/api/stickers/${imageB.id}?app_id=${appId}`);
    const urlBefore = first.body.data.image_url;

    await prisma.image.update({
      where: { id: imageB.id },
      data: { image_url: `https://example.test/${suffix}/b-v2.webp` },
    });

    const cached = await request(app).get(`/api/stickers/${imageB.id}?app_id=${appId}`);
    expect(cached.body.data.image_url).toBe(urlBefore);

    await evictKeys(redis, [singleStickerCacheKey(imageB.id)]);
    const fresh = await request(app).get(`/api/stickers/${imageB.id}?app_id=${appId}`);
    expect(fresh.body.data.image_url).toBe(`https://example.test/${suffix}/b-v2.webp`);
  });

  it("never leaks a cached sticker to another tenant", async () => {
    // imageB is cached for the owning tenant from the previous test.
    const owner = await request(app).get(`/api/stickers/${imageB.id}?app_id=${appId}`);
    expect(owner.status).toBe(200);

    const foreign = await request(app).get(`/api/stickers/${imageB.id}?app_id=${otherAppId}`);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("STICKER_NOT_FOUND");

    const otherWay = await request(app).get(`/api/stickers/${otherImage.id}?app_id=${appId}`);
    expect(otherWay.status).toBe(404);
  });
});
