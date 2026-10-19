import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";

const fakeRedis = { ping: async () => "PONG", incr: async () => 1, expire: async () => 1 };

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const tagName = `single${suffix}`;

let app;
let prisma;
let appId;
let otherAppId;
let visibleId;
let hiddenId;
let otherId;

beforeAll(async () => {
  prisma = getPrisma();
  appId = randomUUID();
  otherAppId = randomUUID();

  await prisma.app.create({
    data: { id: appId, name: "Single Test App", package_name: `test.single.${suffix}` },
  });
  await prisma.app.create({
    data: { id: otherAppId, name: "Single Other App", package_name: `test.single.other.${suffix}` },
  });
  await prisma.tag.create({ data: { name: tagName } });

  const visible = await prisma.image.create({
    data: {
      app_id: appId,
      image_url: `https://example.test/${suffix}/visible.webp`,
      cloudinary_public_id: `test/${suffix}/visible`,
      emojis: ["😺"],
      tags: { connect: [{ name: tagName }] },
    },
  });
  visibleId = visible.id;

  const hidden = await prisma.image.create({
    data: {
      app_id: appId,
      image_url: `https://example.test/${suffix}/hidden.webp`,
      cloudinary_public_id: `test/${suffix}/hidden`,
      is_hidden: true,
    },
  });
  hiddenId = hidden.id;

  const other = await prisma.image.create({
    data: {
      app_id: otherAppId,
      image_url: `https://example.test/${suffix}/other.webp`,
      cloudinary_public_id: `test/${suffix}/other`,
    },
  });
  otherId = other.id;

  app = createApp({ prisma, redis: fakeRedis });
});

afterAll(async () => {
  await prisma.image.deleteMany({ where: { app_id: { in: [appId, otherAppId] } } });
  await prisma.app.deleteMany({ where: { id: { in: [appId, otherAppId] } } });
  await prisma.tag.deleteMany({ where: { name: tagName } });
  await disconnectPrisma();
});

describe("GET /api/stickers/{id}", () => {
  it("returns the sticker DTO for the owning tenant", async () => {
    const res = await request(app).get(`/api/stickers/${visibleId}?app_id=${appId}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(visibleId);
    expect(res.body.data.emojis).toEqual(["😺"]);
    expect(res.body.data.tags).toEqual([tagName]);
    expect(res.body.data).not.toHaveProperty("cloudinary_public_id");
    expect(res.body.data).not.toHaveProperty("is_hidden");
  });

  it("exposes the per-route rate-limit budget", async () => {
    const res = await request(app).get(`/api/stickers/${visibleId}?app_id=${appId}`);
    expect(res.headers["x-ratelimit-limit"]).toBe("120");
  });

  it("returns 404 STICKER_NOT_FOUND for a hidden sticker", async () => {
    const res = await request(app).get(`/api/stickers/${hiddenId}?app_id=${appId}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("STICKER_NOT_FOUND");
  });

  it("returns 404 when the sticker belongs to another tenant", async () => {
    const res = await request(app).get(`/api/stickers/${otherId}?app_id=${appId}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("STICKER_NOT_FOUND");
  });

  it("returns 404 for an unknown id", async () => {
    const res = await request(app).get(`/api/stickers/${randomUUID()}?app_id=${appId}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("STICKER_NOT_FOUND");
  });

  it("returns 400 for a malformed id", async () => {
    const res = await request(app).get(`/api/stickers/not-a-uuid?app_id=${appId}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires a valid app_id", async () => {
    expect((await request(app).get(`/api/stickers/${visibleId}`)).status).toBe(400);
    expect((await request(app).get(`/api/stickers/${visibleId}?app_id=nope`)).status).toBe(400);
  });
});
