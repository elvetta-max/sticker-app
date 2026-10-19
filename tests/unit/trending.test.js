import { describe, it, expect } from "vitest";
import {
  trendingScore,
  trendingDelta,
  trendingKey,
  isAfterCursor,
  paginateScored,
  parseWithScores,
} from "../../src/lib/trending.js";

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("trendingScore", () => {
  it("matches the gravity formula (downloads 3x, +2h floor, exponent 1.5)", () => {
    const score = trendingScore({ downloads: 10, shares: 0, created_at: NOW }, NOW);
    expect(score).toBeCloseTo(30 / Math.pow(2, 1.5), 6);
  });

  it("weights downloads 3x over shares", () => {
    const withDownloads = trendingScore({ downloads: 10, shares: 0, created_at: NOW }, NOW);
    const withShares = trendingScore({ downloads: 0, shares: 10, created_at: NOW }, NOW);
    expect(withDownloads).toBeGreaterThan(withShares);
  });

  it("decays with age", () => {
    const fresh = trendingScore({ downloads: 100, shares: 0, created_at: NOW }, NOW);
    const old = trendingScore(
      { downloads: 100, shares: 0, created_at: new Date(NOW.getTime() - 48 * 3_600_000) },
      NOW,
    );
    expect(fresh).toBeGreaterThan(old);
  });
});

describe("trendingKey", () => {
  it("namespaces per app", () => {
    expect(trendingKey("app1")).toBe("trending:stickers:app1");
  });
});

describe("trendingDelta", () => {
  it("uses the action weight over the gravity denominator", () => {
    expect(trendingDelta({ created_at: NOW }, "downloads", NOW)).toBeCloseTo(
      3 / Math.pow(2, 1.5),
      6,
    );
    expect(trendingDelta({ created_at: NOW }, "shares", NOW)).toBeCloseTo(1 / Math.pow(2, 1.5), 6);
  });

  it("matches the per-unit change in trendingScore", () => {
    const image = { downloads: 5, shares: 2, created_at: new Date(NOW.getTime() - 3_600_000) };
    const before = trendingScore(image, NOW);
    const after = trendingScore({ ...image, downloads: image.downloads + 1 }, NOW);
    expect(after - before).toBeCloseTo(trendingDelta(image, "downloads", NOW), 9);
  });

  it("returns 0 for an unknown field", () => {
    expect(trendingDelta({ created_at: NOW }, "bogus", NOW)).toBe(0);
  });
});

describe("parseWithScores", () => {
  it("pairs members with their scores", () => {
    expect(parseWithScores(["a", "3", "b", "2.5"])).toEqual([
      { id: "a", score: 3 },
      { id: "b", score: 2.5 },
    ]);
  });
});

describe("paginateScored", () => {
  // ZREVRANGE returns equal-score members reverse-lexicographically: c before b.
  const items = [
    { id: "a", score: 3 },
    { id: "c", score: 2 },
    { id: "b", score: 2 },
    { id: "d", score: 1 },
  ];

  it("returns the first page with a next cursor", () => {
    const { page, hasMore, next } = paginateScored(items, { limit: 2 });
    expect(page.map((i) => i.id)).toEqual(["a", "c"]);
    expect(hasMore).toBe(true);
    expect(next).toEqual({ score: 2, id: "c" });
  });

  it("resumes strictly after the cursor across a score tie", () => {
    const { page, hasMore, next } = paginateScored(items, {
      cursor: { score: 2, id: "c" },
      limit: 2,
    });
    expect(page.map((i) => i.id)).toEqual(["b", "d"]);
    expect(hasMore).toBe(false);
    expect(next).toBeNull();
  });

  it("treats equal-score ids with reverse-lexicographic ordering", () => {
    expect(isAfterCursor({ score: 2, id: "b" }, { score: 2, id: "c" })).toBe(true);
    expect(isAfterCursor({ score: 2, id: "c" }, { score: 2, id: "c" })).toBe(false);
    expect(isAfterCursor({ score: 3, id: "a" }, { score: 2, id: "c" })).toBe(false);
  });
});
