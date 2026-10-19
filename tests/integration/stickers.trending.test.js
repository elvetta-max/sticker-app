import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { recomputeTrendingForApp } from "../../src/workers/trending.worker.js";

/**
 * Minimal in-memory Redis double supporting the sorted-set commands the trending
 * reader/worker rely on (zadd, zrevrangebyscore WITHSCORES, pipeline, del).
 */
function createFakeRedis() {
  const zsets = new Map();

  const api = {
    async ping() {
      return "PONG";
    },
    async incr() {
      return 1;
    },
    async expire() {
      return 1;
    },
    async get() {
      return null;
    },
    async set() {
      return "OK";
    },
    async scan() {
      return ["0", []];
    },
    async del(...keys) {
      let removed = 0;
      for (const key of keys) {
        if (zsets.delete(key)) removed += 1;
      }
      return removed;
    },
    async zadd(key, score, member) {
      if (!zsets.has(key)) zsets.set(key, new Map());
      const members = zsets.get(key);
      const existed = members.has(member);
      members.set(member, Number(score));
      return existed ? 0 : 1;
    },
    async zrevrangebyscore(key, max, min, ...rest) {
      const members = zsets.get(key) ?? new Map();
      const withScores = rest.map(String).includes("WITHSCORES");
      const hi = max === "+inf" || max === "inf" ? Infinity : Number(max);
      const lo = min === "-inf" ? -Infinity : Number(min);
      const items = [...members.entries()]
        .map(([id, score]) => ({ id, score }))
        .filter((item) => item.score <= hi && item.score >= lo)
        // desc by score; equal scores reverse-lexicographic (matches ZREVRANGE)
        .sort((a, b) => b.score - a.score || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const flat = [];
      for (const item of items) {
        flat.push(item.id);
        if (withScores) flat.push(String(item.score));
      }
      return flat;
    },
    pipeline() {
      const ops = [];
      const chain = {
        del: (key) => {
          ops.push(() => api.del(key));
          return chain;
        },
        zadd: (key, score, member) => {
          ops.push(() => api.zadd(key, score, member));
          return chain;
        },
        expire: () => chain,
        exec: async () => {
          for (const op of ops) await op();
          return [];
        },
      };
      return chain;
    },
  };

  return api;
}

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const base = new Date("2026-01-01T00:00:00.000Z");

let app;
let prisma;
let redis;
let appId;
let emptyAppId;
const rankedIds = [];
let hiddenId;

beforeAll(async () => {
  prisma = getPrisma();
  redis = createFakeRedis();
  appId = randomUUID();
  emptyAppId = randomUUID();

  await prisma.app.create({
    data: { id: appId, name: "Trending Test App", package_name: `test.trending.${suffix}` },
  });
  await prisma.app.create({
    data: {
      id: emptyAppId,
      name: "Trending Empty App",
      package_name: `test.trending.empty.${suffix}`,
    },
  });

  // Same created_at so ordering is driven purely by engagement.
  for (const downloads of [100, 50, 10]) {
    const image = await prisma.image.create({
      data: {
        app_id: appId,
        image_url: `https://example.test/${suffix}/d${downloads}.webp`,
        cloudinary_public_id: `test/${suffix}/d${downloads}`,
        downloads,
        created_at: base,
      },
    });
    rankedIds.push(image.id);
  }

  const hidden = await prisma.image.create({
    data: {
      app_id: appId,
      image_url: `https://example.test/${suffix}/hidden.webp`,
      cloudinary_public_id: `test/${suffix}/hidden`,
      downloads: 9999,
      is_hidden: true,
      created_at: base,
    },
  });
  hiddenId = hidden.id;

  await recomputeTrendingForApp({ prisma, redis, appId, now: new Date() });

  app = createApp({ prisma, redis });
});

afterAll(async () => {
  await prisma.image.deleteMany({ where: { app_id: { in: [appId, emptyAppId] } } });
  await prisma.app.deleteMany({ where: { id: { in: [appId, emptyAppId] } } });
  await disconnectPrisma();
});

describe("GET /api/stickers?sort_by=trending", () => {
  it("returns stickers ordered by trending score", async () => {
    const res = await request(app).get(`/api/stickers?app_id=${appId}&sort_by=trending`);
    expect(res.status).toBe(200);
    expect(res.body.data.map((s) => s.id)).toEqual(rankedIds);
  });

  it("excludes hidden stickers even when they have the highest score", async () => {
    const res = await request(app).get(`/api/stickers?app_id=${appId}&sort_by=trending`);
    expect(res.body.data.some((s) => s.id === hiddenId)).toBe(false);
  });

  it("paginates across the stable snapshot with a score cursor", async () => {
    const page1 = await request(app).get(`/api/stickers?app_id=${appId}&sort_by=trending&limit=2`);
    expect(page1.body.data.map((s) => s.id)).toEqual(rankedIds.slice(0, 2));
    expect(page1.body.next_cursor).toBeTruthy();

    const page2 = await request(app).get(
      `/api/stickers?app_id=${appId}&sort_by=trending&limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`,
    );
    expect(page2.body.data.map((s) => s.id)).toEqual(rankedIds.slice(2));
    expect(page2.body.next_cursor).toBeNull();
  });

  it("returns an empty feed when the snapshot has no stickers", async () => {
    await recomputeTrendingForApp({ prisma, redis, appId: emptyAppId, now: new Date() });
    const res = await request(app).get(`/api/stickers?app_id=${emptyAppId}&sort_by=trending`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.next_cursor).toBeNull();
  });

  it("returns 404 for an unknown tenant", async () => {
    const res = await request(app).get(`/api/stickers?app_id=${randomUUID()}&sort_by=trending`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects an invalid score cursor", async () => {
    const res = await request(app).get(
      `/api/stickers?app_id=${appId}&sort_by=trending&cursor=@@bad@@`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
