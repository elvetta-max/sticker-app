import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { searchPrefixKey, DAY_MS } from "../../src/lib/search.js";
import { recomputeSearchSuggest } from "../../src/workers/trending.worker.js";

/** In-memory Redis double: lex sorted sets + cache (GET/SET) + counters + pipeline. */
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
    async zadd(key, _score, member) {
      if (!zsets.has(key)) zsets.set(key, new Map());
      const members = zsets.get(key);
      const existed = members.has(member);
      members.set(member, Number(_score));
      return existed ? 0 : 1;
    },
    async zrangebylex(key, min, max, ...rest) {
      const members = [...(zsets.get(key) ?? new Map()).keys()].sort();
      const lo = String(min).startsWith("[") ? String(min).slice(1) : String(min);
      const hi = String(max).startsWith("[") ? String(max).slice(1) : String(max);
      let out = members.filter((m) => m >= lo && m <= hi);
      const idx = rest.map(String).indexOf("LIMIT");
      if (idx !== -1) {
        const offset = Number(rest[idx + 1]);
        const count = Number(rest[idx + 2]);
        out = out.slice(offset, offset + count);
      }
      return out;
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
let appId;
let otherAppId;
let emptyAppId;
let manyAppId;

beforeAll(async () => {
  prisma = getPrisma();
  redis = createMemoryRedis();

  appId = randomUUID();
  otherAppId = randomUUID();
  emptyAppId = randomUUID();
  manyAppId = randomUUID();
  for (const [id, name] of [
    [appId, "suggest"],
    [otherAppId, "suggest-other"],
    [emptyAppId, "suggest-empty"],
    [manyAppId, "suggest-many"],
  ]) {
    await prisma.app.create({
      data: { id, name: `Suggest ${name}`, package_name: `test.suggest.${name}.${suffix}` },
    });
  }

  const rows = [
    ...[1, 2, 3].map(() => ({ app_id: appId, device_id: "d", keyword: "cats" })),
    { app_id: appId, device_id: "d", keyword: "cat memes" },
    { app_id: appId, device_id: "d", keyword: "dogs" },
    { app_id: appId, device_id: "d", keyword: "birds" },
    { app_id: appId, device_id: "d", keyword: "ca" },
    {
      app_id: appId,
      device_id: "d",
      keyword: "zzz",
      created_at: new Date(now.getTime() - 8 * DAY_MS),
    },
    ...[1, 2, 3].map(() => ({ app_id: otherAppId, device_id: "d", keyword: "fish" })),
    ...Array.from({ length: 10 }, (_, i) => ({
      app_id: manyAppId,
      device_id: "d",
      keyword: `k${String(i).padStart(2, "0")}`,
    })),
  ];
  await prisma.searchQuery.createMany({ data: rows });

  await recomputeSearchSuggest({ prisma, redis, now });
  app = createApp({ prisma, redis });
});

afterAll(async () => {
  await prisma.searchQuery.deleteMany({
    where: { app_id: { in: [appId, otherAppId, emptyAppId, manyAppId] } },
  });
  await prisma.app.deleteMany({
    where: { id: { in: [appId, otherAppId, emptyAppId, manyAppId] } },
  });
  await disconnectPrisma();
});

const suggest = (id, q) =>
  request(app).get(`/api/search/suggest?app_id=${id}&q=${encodeURIComponent(q)}`);

describe("recomputeSearchSuggest", () => {
  it("builds a lex ZSET of recent keywords and excludes the old window", async () => {
    const cats = await redis.zrangebylex(searchPrefixKey(appId), "[", "[\xff");
    expect(cats).toEqual(["birds", "ca", "cat memes", "cats", "dogs"]);

    // Stale key for a tenant with no recent searches is cleared.
    await redis.zadd(searchPrefixKey(emptyAppId), 0, "ghost");
    await recomputeSearchSuggest({ prisma, redis, now });
    expect(await redis.zrangebylex(searchPrefixKey(emptyAppId), "[", "[\xff")).toEqual([]);
  });
});

describe("GET /api/search/suggest", () => {
  it("returns up to 8 keywords starting with the normalized prefix", async () => {
    const cat = await suggest(appId, "cat");
    expect(cat.status).toBe(200);
    expect(cat.body).toEqual({ success: true, suggestions: ["cat memes", "cats"] });

    const ca = await suggest(appId, "ca");
    expect(ca.body.suggestions).toEqual(["ca", "cat memes", "cats"]);

    const normalized = await suggest(appId, "CaTs!!!");
    expect(normalized.body.suggestions).toEqual(["cats"]);

    const many = await suggest(manyAppId, "k0");
    expect(many.body.suggestions).toHaveLength(8);
  });

  it("returns an empty list for a too-short or non-matching query", async () => {
    expect((await suggest(appId, "c")).body.suggestions).toEqual([]);
    expect((await suggest(appId, "")).body.suggestions).toEqual([]);
    expect((await suggest(appId, "xyz")).body.suggestions).toEqual([]);
  });

  it("isolates tenants and 404s/validates input", async () => {
    expect((await suggest(appId, "fish")).body.suggestions).toEqual([]);
    expect((await suggest(otherAppId, "fish")).body.suggestions).toEqual(["fish"]);

    expect((await suggest(randomUUID(), "cat")).status).toBe(404);
    expect((await request(app).get("/api/search/suggest?q=cat")).status).toBe(400);
    expect((await request(app).get("/api/search/suggest?app_id=nope&q=cat")).status).toBe(400);
  });

  it("stays fresh from live search logging", async () => {
    const post = await request(app)
      .post("/api/search")
      .send({ device_id: `dev-${suffix}`, app_id: appId, keyword: "Kittens" });
    expect(post.status).toBe(200);

    const res = await suggest(appId, "kitt");
    expect(res.body.suggestions).toEqual(["kittens"]);
  });

  it("rate-limits at 60/min per IP", async () => {
    let last;
    for (let i = 0; i < 61; i += 1) last = await suggest(appId, "cat");
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe("RATE_LIMITED");
  });
});
