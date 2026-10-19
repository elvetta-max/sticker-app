import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";

const fakeRedis = { ping: async () => "PONG", incr: async () => 1, expire: async () => 1 };

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const feedTag = `feedcat${suffix}`;
const specialTag = `special${suffix}`;
const base = new Date("2026-01-01T00:00:00.000Z");

let app;
let prisma;
let appId;
let otherAppId;
const visibleIds = [];
let hiddenId;

beforeAll(async () => {
  prisma = getPrisma();
  appId = randomUUID();
  otherAppId = randomUUID();

  await prisma.app.create({
    data: { id: appId, name: "Feed Test App", package_name: `test.feed.${suffix}` },
  });
  await prisma.app.create({
    data: { id: otherAppId, name: "Feed Other App", package_name: `test.other.${suffix}` },
  });

  await prisma.tag.create({ data: { name: feedTag } });
  await prisma.tag.create({ data: { name: specialTag } });

  // 5 visible images, newest first (v0 newest).
  for (let i = 0; i < 5; i += 1) {
    const image = await prisma.image.create({
      data: {
        app_id: appId,
        image_url: `https://example.test/${suffix}/v${i}.webp`,
        cloudinary_public_id: `test/${suffix}/v${i}`,
        created_at: new Date(base.getTime() - i * 60_000),
        tags: { connect: [{ name: feedTag }, ...(i === 0 ? [{ name: specialTag }] : [])] },
      },
    });
    visibleIds.push(image.id);
  }

  const hidden = await prisma.image.create({
    data: {
      app_id: appId,
      image_url: `https://example.test/${suffix}/hidden.webp`,
      cloudinary_public_id: `test/${suffix}/hidden`,
      is_hidden: true,
      created_at: new Date(base.getTime() + 60_000),
      tags: { connect: [{ name: feedTag }] },
    },
  });
  hiddenId = hidden.id;

  for (let i = 0; i < 2; i += 1) {
    await prisma.image.create({
      data: {
        app_id: otherAppId,
        image_url: `https://example.test/${suffix}/o${i}.webp`,
        cloudinary_public_id: `test/${suffix}/o${i}`,
        tags: { connect: [{ name: feedTag }] },
      },
    });
  }

  app = createApp({ prisma, redis: fakeRedis });
});

afterAll(async () => {
  await prisma.image.deleteMany({ where: { app_id: { in: [appId, otherAppId] } } });
  await prisma.app.deleteMany({ where: { id: { in: [appId, otherAppId] } } });
  await prisma.tag.deleteMany({ where: { name: { in: [feedTag, specialTag] } } });
  await disconnectPrisma();
});

describe("GET /api/stickers", () => {
  it("returns visible stickers for the app, newest first, excluding hidden", async () => {
    const res = await request(app).get(`/api/stickers?app_id=${appId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.data.map((s) => s.id)).toEqual(visibleIds);
    expect(res.body.data.some((s) => s.id === hiddenId)).toBe(false);
  });

  it("does not expose internal fields", async () => {
    const res = await request(app).get(`/api/stickers?app_id=${appId}`);
    const sticker = res.body.data[0];
    expect(sticker).not.toHaveProperty("cloudinary_public_id");
    expect(sticker).not.toHaveProperty("is_hidden");
    expect(Array.isArray(sticker.tags)).toBe(true);
  });

  it("does not leak another tenant's stickers", async () => {
    const res = await request(app).get(`/api/stickers?app_id=${otherAppId}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });

  it("paginates with a stable cursor across pages", async () => {
    const page1 = await request(app).get(`/api/stickers?app_id=${appId}&limit=2`);
    expect(page1.body.data.map((s) => s.id)).toEqual(visibleIds.slice(0, 2));
    expect(page1.body.next_cursor).toBeTruthy();

    const page2 = await request(app).get(
      `/api/stickers?app_id=${appId}&limit=2&cursor=${encodeURIComponent(page1.body.next_cursor)}`,
    );
    expect(page2.body.data.map((s) => s.id)).toEqual(visibleIds.slice(2, 4));
    expect(page2.body.next_cursor).toBeTruthy();

    const page3 = await request(app).get(
      `/api/stickers?app_id=${appId}&limit=2&cursor=${encodeURIComponent(page2.body.next_cursor)}`,
    );
    expect(page3.body.data.map((s) => s.id)).toEqual(visibleIds.slice(4, 5));
    expect(page3.body.next_cursor).toBeNull();
  });

  it("filters by search term against tags (hidden still excluded)", async () => {
    const res = await request(app).get(`/api/stickers?app_id=${appId}&search=${feedTag}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);

    const special = await request(app).get(`/api/stickers?app_id=${appId}&search=${specialTag}`);
    expect(special.body.data).toHaveLength(1);
    expect(special.body.data[0].id).toBe(visibleIds[0]);
  });

  it("rejects limit over the cap", async () => {
    const res = await request(app).get(`/api/stickers?app_id=${appId}&limit=51`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires a valid app_id", async () => {
    expect((await request(app).get("/api/stickers")).status).toBe(400);
    expect((await request(app).get("/api/stickers?app_id=not-a-uuid")).status).toBe(400);
  });

  it("returns 404 for an unknown tenant", async () => {
    const res = await request(app).get(`/api/stickers?app_id=${randomUUID()}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects an invalid cursor", async () => {
    const res = await request(app).get(`/api/stickers?app_id=${appId}&cursor=@@bad@@`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
