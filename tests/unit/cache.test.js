import { describe, it, expect } from "vitest";
import {
  evictKeys,
  stickerCachePatterns,
  feedCacheKey,
  feedCachePattern,
  singleStickerCacheKey,
  adsCacheKey,
  versionCacheKey,
  getCachedJson,
  setCachedJson,
  readThroughCache,
  singleFlight,
  clearSingleFlight,
} from "../../src/lib/cache.js";

function globToRegExp(pattern) {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

function fakeRedis(keys) {
  const store = new Set(keys);
  const deleted = [];
  return {
    deleted,
    async scan(_cursor, _match, pattern) {
      return ["0", [...store].filter((key) => globToRegExp(pattern).test(key))];
    },
    async del(...ks) {
      for (const key of ks) if (store.delete(key)) deleted.push(key);
      return ks.length;
    },
  };
}

describe("stickerCachePatterns", () => {
  it("covers list, trending and single-sticker keys", () => {
    expect(stickerCachePatterns("app1", "s1")).toEqual([
      "stickers:app1:*",
      "trending:stickers:app1",
      "sticker:s1",
    ]);
  });
});

describe("evictKeys", () => {
  it("deletes only keys matching the patterns", async () => {
    const redis = fakeRedis([
      "stickers:a1:hash1",
      "stickers:a1:hash2",
      "trending:stickers:a1",
      "sticker:s1",
      "stickers:a2:hash",
      "trending:search:a1",
    ]);

    const count = await evictKeys(redis, stickerCachePatterns("a1", "s1"));

    expect(count).toBe(4);
    expect(new Set(redis.deleted)).toEqual(
      new Set(["stickers:a1:hash1", "stickers:a1:hash2", "trending:stickers:a1", "sticker:s1"]),
    );
  });

  it("no-ops when the client has no scan", async () => {
    await expect(evictKeys({ del: async () => 1 }, ["x"])).resolves.toBe(0);
  });
});

describe("cache keys", () => {
  it("is stable for identical feed queries", () => {
    const q = { sort_by: "latest", limit: 20, cursor: "abc", search: "cat" };
    expect(feedCacheKey("app1", q)).toBe(feedCacheKey("app1", { ...q }));
  });

  it("differs by app, limit, cursor, search and sort", () => {
    const base = { sort_by: "latest", limit: 20 };
    const key = feedCacheKey("app1", base);
    expect(feedCacheKey("app2", base)).not.toBe(key);
    expect(feedCacheKey("app1", { ...base, limit: 50 })).not.toBe(key);
    expect(feedCacheKey("app1", { ...base, cursor: "c" })).not.toBe(key);
    expect(feedCacheKey("app1", { ...base, search: "cat" })).not.toBe(key);
    expect(feedCacheKey("app1", { ...base, sort_by: "trending" })).not.toBe(key);
  });

  it("namespaces the other keys", () => {
    expect(feedCachePattern("app1")).toBe("stickers:app1:*");
    expect(singleStickerCacheKey("s1")).toBe("sticker:s1");
    expect(adsCacheKey("app1")).toBe("ads:app1");
    expect(versionCacheKey("app1")).toBe("version:app1");
  });
});

describe("cache read/write", () => {
  function memoryRedis() {
    const store = new Map();
    return {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        store.set(key, value);
        return "OK";
      },
    };
  }

  it("round-trips JSON values", async () => {
    const redis = memoryRedis();
    await setCachedJson(redis, "k", { a: 1 }, 60);
    expect(await getCachedJson(redis, "k")).toEqual({ a: 1 });
  });

  it("no-ops on a client without get/set", async () => {
    expect(await getCachedJson({}, "k")).toBeUndefined();
    await expect(setCachedJson({}, "k", { a: 1 }, 60)).resolves.toBeUndefined();
  });

  it("readThroughCache loads once and serves the cached value afterwards", async () => {
    clearSingleFlight();
    const redis = memoryRedis();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { n: calls };
    };

    const first = await readThroughCache({ redis, key: "rt", ttlSeconds: 60, loader });
    const second = await readThroughCache({ redis, key: "rt", ttlSeconds: 60, loader });

    expect(first).toEqual({ n: 1 });
    expect(second).toEqual({ n: 1 });
    expect(calls).toBe(1);
  });

  it("single-flights a concurrent stampede", async () => {
    clearSingleFlight();
    const redis = memoryRedis();
    let calls = 0;
    const loader = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ok: true };
    };

    const [a, b] = await Promise.all([
      readThroughCache({ redis, key: "sf", ttlSeconds: 60, loader }),
      readThroughCache({ redis, key: "sf", ttlSeconds: 60, loader }),
    ]);

    expect(calls).toBe(1);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
  });

  it("clears the in-flight entry after completion", async () => {
    clearSingleFlight();
    let calls = 0;
    const p = singleFlight("x", async () => {
      calls += 1;
      return 1;
    });
    await expect(singleFlight("x", async () => 2)).resolves.toBe(1);
    await p;
    await expect(singleFlight("x", async () => 3)).resolves.toBe(3);
    expect(calls).toBe(1);
  });
});
