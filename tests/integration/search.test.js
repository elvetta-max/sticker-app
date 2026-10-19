import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { trendingSearchKey, DAY_MS } from "../../src/lib/search.js";
import { recomputeSearchTrending, purgeSearchQueries } from "../../src/workers/trending.worker.js";

/** In-memory Redis double: INCR counters + sorted sets + pipeline. */
function createMemoryRedis() {
  const kv = new Map();
  const counts = new Map();
  const zsets = new Map();

  const api = {
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
      for (const key of keys) {
        if (zsets.delete(key)) removed += 1;
        if (kv.delete(key)) removed += 1;
        if (counts.delete(key)) removed += 1;
      }
      return removed;
    },
    async scan() {
      return ["0", []];
    },
    async zadd(key, score, member) {
      if (!zsets.has(key)) zsets.set(key, new Map());
      const members = zsets.get(key);
      const existed = members.has(member);
      members.set(member, Number(score));
      return existed ? 0 : 1;
    },
    async zincrby(key, delta, member) {
      if (!zsets.has(key)) zsets.set(key, new Map());
      const members = zsets.get(key);
      const next = (members.get(member) ?? 0) + Number(delta);
      members.set(member, next);
      return next;
    },
    async zrevrange(key, start, stop, ...rest) {
      const withScores = rest.map(String).includes("WITHSCORES");
      const items = [...(zsets.get(key) ?? new Map()).entries()]
        .map(([member, score]) => ({ member, score }))
        .sort(
          (a, b) => b.score - a.score || (a.member < b.member ? 1 : a.member > b.member ? -1 : 0),
        );
      const end = stop < 0 ? items.length + Number(stop) + 1 : Number(stop) + 1;
      const flat = [];
      for (const item of items.slice(Number(start), end)) {
        flat.push(item.member);
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
const now = new Date();

let app;
let prisma;
let redis;
let logAppId;
let trendAppId;
let otherAppId;
let emptyAppId;

beforeAll(async () => {
  prisma = getPrisma();
  redis = createMemoryRedis();

  logAppId = randomUUID();
  trendAppId = randomUUID();
  otherAppId = randomUUID();
  emptyAppId = randomUUID();

  for (const [id, name] of [
    [logAppId, "log"],
    [trendAppId, "trend"],
    [otherAppId, "other"],
    [emptyAppId, "empty"],
  ]) {
    await prisma.app.create({
      data: { id, name: `Search ${name} App`, package_name: `test.search.${name}.${suffix}` },
    });
  }

  app = createApp({ prisma, redis });
});

afterAll(async () => {
  await prisma.searchQuery.deleteMany({
    where: { app_id: { in: [logAppId, trendAppId, otherAppId, emptyAppId] } },
  });
  await prisma.app.deleteMany({
    where: { id: { in: [logAppId, trendAppId, otherAppId, emptyAppId] } },
  });
  await disconnectPrisma();
});

function postSearch(body) {
  return request(app).post("/api/search").send(body);
}

describe("POST /api/search", () => {
  it("stores the normalized keyword and nudges the trending ZSET", async () => {
    const res = await postSearch({
      device_id: "dev-log-1",
      app_id: logAppId,
      keyword: "  CaTs!!!  ",
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { keyword: "cats" } });

    const row = await prisma.searchQuery.findFirst({ where: { app_id: logAppId } });
    expect(row.keyword).toBe("cats");
    expect(row.device_id).toBe("dev-log-1");

    const flat = await redis.zrevrange(trendingSearchKey(logAppId), 0, -1, "WITHSCORES");
    expect(flat).toEqual(["cats", "1"]);
  });

  it("rejects a keyword that normalizes to empty without storing it", async () => {
    const res = await postSearch({ device_id: "dev-log-2", app_id: logAppId, keyword: "!!!" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(
      await prisma.searchQuery.count({ where: { app_id: logAppId, device_id: "dev-log-2" } }),
    ).toBe(0);
  });

  it("404s for an unknown tenant without storing anything", async () => {
    const res = await postSearch({ device_id: "dev-log-3", app_id: randomUUID(), keyword: "cats" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("validates the body", async () => {
    expect((await postSearch({ app_id: logAppId, keyword: "x" })).status).toBe(400);
    expect((await postSearch({ device_id: "d", app_id: logAppId })).status).toBe(400);
    expect((await postSearch({ device_id: "d", app_id: "nope", keyword: "x" })).status).toBe(400);
    expect(
      (await postSearch({ device_id: "d", app_id: logAppId, keyword: "x".repeat(65) })).status,
    ).toBe(400);
  });

  it("rate-limits at 30/min per device", async () => {
    const device = "dev-rl";
    let last;
    for (let i = 0; i < 31; i += 1) {
      last = await postSearch({ device_id: device, app_id: logAppId, keyword: "cat" });
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("GET /api/search/trending", () => {
  beforeAll(async () => {
    const rows = [
      ...[1, 2, 3].map(() => ({ app_id: trendAppId, device_id: "d", keyword: "cats" })),
      ...[1, 2].map(() => ({ app_id: trendAppId, device_id: "d", keyword: "dogs" })),
      { app_id: trendAppId, device_id: "d", keyword: "birds" },
      // Outside the 7-day window — must be excluded from trending.
      {
        app_id: trendAppId,
        device_id: "d",
        keyword: "dinosaurs",
        created_at: new Date(now.getTime() - 8 * DAY_MS),
      },
      // Another tenant, to prove isolation.
      ...[1, 2, 3, 4, 5].map(() => ({ app_id: otherAppId, device_id: "d", keyword: "fish" })),
    ];
    await prisma.searchQuery.createMany({ data: rows });

    // Stale key for an app with no recent searches must be cleared.
    await redis.zadd(trendingSearchKey(emptyAppId), 9, "ghost");

    await recomputeSearchTrending({ prisma, redis, now });
  });

  it("returns keywords ordered by count, scoped to the tenant", async () => {
    const res = await request(app).get(`/api/search/trending?app_id=${trendAppId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([
      { keyword: "cats", count: 3 },
      { keyword: "dogs", count: 2 },
      { keyword: "birds", count: 1 },
    ]);
  });

  it("honors the limit (default 10, max 30)", async () => {
    const limited = await request(app).get(`/api/search/trending?app_id=${trendAppId}&limit=2`);
    expect(limited.body.data.map((d) => d.keyword)).toEqual(["cats", "dogs"]);

    expect(
      (await request(app).get(`/api/search/trending?app_id=${trendAppId}&limit=31`)).status,
    ).toBe(400);
  });

  it("does not leak another tenant's trending searches", async () => {
    const res = await request(app).get(`/api/search/trending?app_id=${otherAppId}`);
    expect(res.body.data).toEqual([{ keyword: "fish", count: 5 }]);
  });

  it("returns an empty list for a tenant with no recent searches (stale key cleared)", async () => {
    const res = await request(app).get(`/api/search/trending?app_id=${emptyAppId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("404s for an unknown tenant and validates the query", async () => {
    expect((await request(app).get(`/api/search/trending?app_id=${randomUUID()}`)).status).toBe(
      404,
    );
    expect((await request(app).get("/api/search/trending")).status).toBe(400);
  });
});

describe("search maintenance jobs", () => {
  it("purges only queries older than the 15-day retention window", async () => {
    const oldRow = await prisma.searchQuery.create({
      data: {
        app_id: otherAppId,
        device_id: "purge-old",
        keyword: "ancient",
        created_at: new Date(now.getTime() - 16 * DAY_MS),
      },
    });
    const recentRow = await prisma.searchQuery.create({
      data: { app_id: otherAppId, device_id: "purge-recent", keyword: "fresh" },
    });

    const result = await purgeSearchQueries({ prisma, now });
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    expect(await prisma.searchQuery.findUnique({ where: { id: oldRow.id } })).toBeNull();
    expect(await prisma.searchQuery.findUnique({ where: { id: recentRow.id } })).not.toBeNull();
  });
});
