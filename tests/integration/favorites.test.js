import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";

/** In-memory Redis double for the rate-limit middleware (INCR + EXPIRE). */
function createFakeRedis() {
  const counts = new Map();
  return {
    async ping() {
      return "PONG";
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
let appId;
let otherAppId;
let visibleA;
let visibleB;
let visibleC;
let hiddenId;
let otherStickerId;

beforeAll(async () => {
  prisma = getPrisma();
  appId = randomUUID();
  otherAppId = randomUUID();

  await prisma.app.create({
    data: { id: appId, name: "Favorites Test App", package_name: `test.fav.${suffix}` },
  });
  await prisma.app.create({
    data: {
      id: otherAppId,
      name: "Favorites Other App",
      package_name: `test.fav.other.${suffix}`,
    },
  });

  const makeImage = (app_id, name, is_hidden = false) =>
    prisma.image.create({
      data: {
        app_id,
        is_hidden,
        image_url: `https://example.test/${suffix}/${name}.webp`,
        cloudinary_public_id: `test/${suffix}/${name}`,
      },
    });

  visibleA = (await makeImage(appId, "a")).id;
  visibleB = (await makeImage(appId, "b")).id;
  visibleC = (await makeImage(appId, "c")).id;
  hiddenId = (await makeImage(appId, "hidden", true)).id;
  otherStickerId = (await makeImage(otherAppId, "other")).id;

  app = createApp({ prisma, redis: createFakeRedis() });
});

afterAll(async () => {
  await prisma.image.deleteMany({ where: { app_id: { in: [appId, otherAppId] } } });
  await prisma.app.deleteMany({ where: { id: { in: [appId, otherAppId] } } });
  await disconnectPrisma();
});

function addBatch(device, ids, action = "ADD") {
  return request(app)
    .post("/api/user/favorites/batch")
    .send({ device_id: device, app_id: appId, favorite_image_ids: ids, action });
}

describe("POST /api/user/favorites/batch — ADD", () => {
  it("persists favorites and is idempotent on replay", async () => {
    const device = "dev-add-1";
    const ids = [visibleA, visibleB, visibleC];

    const first = await addBatch(device, ids);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      success: true,
      processed_count: 3,
      message: "Batch favorites synchronized successfully.",
    });

    const replay = await addBatch(device, ids);
    expect(replay.status).toBe(200);
    expect(replay.body.processed_count).toBe(0);

    expect(await prisma.favorite.count({ where: { device_id: device } })).toBe(3);
  });

  it("deduplicates ids within a single batch", async () => {
    const device = "dev-add-dup";
    const res = await addBatch(device, [visibleA, visibleA, visibleB]);
    expect(res.body.processed_count).toBe(2);
    expect(await prisma.favorite.count({ where: { device_id: device } })).toBe(2);
  });

  it("drops hidden and cross-tenant sticker ids instead of storing them", async () => {
    const device = "dev-add-filtered";
    const res = await addBatch(device, [visibleA, hiddenId, otherStickerId]);

    expect(res.body.processed_count).toBe(1);
    const rows = await prisma.favorite.findMany({ where: { device_id: device } });
    expect(rows.map((r) => r.image_id)).toEqual([visibleA]);
  });

  it("accepts an empty batch as a no-op", async () => {
    const res = await addBatch("dev-add-empty", []);
    expect(res.status).toBe(200);
    expect(res.body.processed_count).toBe(0);
  });
});

describe("POST /api/user/favorites/batch — REMOVE", () => {
  it("removes existing favorites and is idempotent", async () => {
    const device = "dev-remove-1";
    await addBatch(device, [visibleA, visibleB, visibleC]);

    const removed = await addBatch(device, [visibleA, visibleB], "REMOVE");
    expect(removed.status).toBe(200);
    expect(removed.body.processed_count).toBe(2);

    const again = await addBatch(device, [visibleA, visibleB], "REMOVE");
    expect(again.body.processed_count).toBe(0);

    const remaining = await prisma.favorite.findMany({ where: { device_id: device } });
    expect(remaining.map((r) => r.image_id)).toEqual([visibleC]);
  });
});

describe("POST /api/user/favorites/batch — isolation & validation", () => {
  it("404s for an unknown tenant", async () => {
    const res = await request(app)
      .post("/api/user/favorites/batch")
      .send({
        device_id: "d",
        app_id: randomUUID(),
        favorite_image_ids: [visibleA],
        action: "ADD",
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("validates the body", async () => {
    expect((await addBatch(undefined, [visibleA])).status).toBe(400);
    expect((await addBatch("d", [visibleA], "MERGE")).status).toBe(400);

    const tooMany = await addBatch(
      "d",
      Array.from({ length: 201 }, () => randomUUID()),
    );
    expect(tooMany.status).toBe(400);

    const badUuid = await addBatch("d", ["not-a-uuid"]);
    expect(badUuid.status).toBe(400);
    expect(badUuid.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rate-limits at 60/min per device_id", async () => {
    const device = "dev-fav-ratelimited";
    let last;
    for (let i = 0; i < 61; i += 1) {
      last = await addBatch(device, [visibleA]);
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("GET /api/user/favorites", () => {
  const device = "dev-list";

  beforeAll(async () => {
    const now = Date.now();
    const at = (minsAgo) => new Date(now - minsAgo * 60 * 1000);
    await prisma.favorite.createMany({
      data: [
        { device_id: device, app_id: appId, image_id: visibleA, created_at: at(3) },
        { device_id: device, app_id: appId, image_id: visibleB, created_at: at(2) },
        { device_id: device, app_id: appId, image_id: visibleC, created_at: at(1) },
        // Hidden sticker favorited earlier — must never surface.
        { device_id: device, app_id: appId, image_id: hiddenId, created_at: at(4) },
      ],
    });
  });

  it("returns favorites newest-first with cursor pagination, excluding hidden stickers", async () => {
    const first = await request(app).get(
      `/api/user/favorites?device_id=${device}&app_id=${appId}&limit=2`,
    );

    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);
    expect(first.body.data.map((s) => s.id)).toEqual([visibleC, visibleB]);
    expect(first.body.data[0]).toMatchObject({ app_id: appId, image_url: expect.any(String) });
    expect(first.body.next_cursor).toBeTruthy();

    const second = await request(app).get(
      `/api/user/favorites?device_id=${device}&app_id=${appId}&limit=2&cursor=${first.body.next_cursor}`,
    );
    expect(second.body.data.map((s) => s.id)).toEqual([visibleA]);
    expect(second.body.next_cursor).toBeNull();
  });

  it("does not leak another device's favorites", async () => {
    const res = await request(app).get(
      `/api/user/favorites?device_id=some-other-device&app_id=${appId}`,
    );
    expect(res.body.data).toEqual([]);
  });

  it("404s for an unknown tenant and validates the query", async () => {
    expect(
      (await request(app).get(`/api/user/favorites?device_id=${device}&app_id=${randomUUID()}`))
        .status,
    ).toBe(404);

    expect((await request(app).get(`/api/user/favorites?app_id=${appId}`)).status).toBe(400);
    expect(
      (await request(app).get(`/api/user/favorites?device_id=${device}&app_id=${appId}&limit=51`))
        .status,
    ).toBe(400);
  });
});
