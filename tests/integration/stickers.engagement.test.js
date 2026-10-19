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

/** Captures enqueued jobs so we can assert the counter job payload. */
function createQueueStub() {
  const jobs = [];
  return {
    jobs,
    async add(name, data) {
      jobs.push({ name, data });
      return { id: `job-${jobs.length}` };
    },
  };
}

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);

let app;
let prisma;
let queue;
let appId;
let otherAppId;
let stickerId;
let hiddenId;
let otherStickerId;

beforeAll(async () => {
  prisma = getPrisma();
  queue = createQueueStub();
  appId = randomUUID();
  otherAppId = randomUUID();

  await prisma.app.create({
    data: { id: appId, name: "Engagement Test App", package_name: `test.engage.${suffix}` },
  });
  await prisma.app.create({
    data: {
      id: otherAppId,
      name: "Engagement Other App",
      package_name: `test.engage.other.${suffix}`,
    },
  });

  const sticker = await prisma.image.create({
    data: {
      app_id: appId,
      image_url: `https://example.test/${suffix}/visible.webp`,
      cloudinary_public_id: `test/${suffix}/visible`,
      downloads: 10,
      shares: 3,
    },
  });
  stickerId = sticker.id;

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
  otherStickerId = other.id;

  app = createApp({ prisma, redis: createFakeRedis(), stickerQueue: queue });
});

afterAll(async () => {
  await prisma.image.deleteMany({ where: { app_id: { in: [appId, otherAppId] } } });
  await prisma.app.deleteMany({ where: { id: { in: [appId, otherAppId] } } });
  await disconnectPrisma();
});

describe("POST /api/stickers/{id}/download", () => {
  it("returns an optimistic count and enqueues the increment job", async () => {
    queue.jobs.length = 0;
    const res = await request(app)
      .post(`/api/stickers/${stickerId}/download`)
      .send({ app_id: appId, device_id: "device-download-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, current_downloads: 11 });
    expect(queue.jobs).toEqual([
      {
        name: "sticker:increment-counter",
        data: { image_id: stickerId, app_id: appId, field: "downloads" },
      },
    ]);

    const row = await prisma.image.findUnique({ where: { id: stickerId } });
    expect(row.downloads).toBe(10); // write happens in the worker, not here
  });
});

describe("POST /api/stickers/{id}/share", () => {
  it("returns an optimistic count and enqueues the share increment", async () => {
    queue.jobs.length = 0;
    const res = await request(app)
      .post(`/api/stickers/${stickerId}/share`)
      .send({ app_id: appId, device_id: "device-share-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, current_shares: 4 });
    expect(queue.jobs[0].data).toEqual({
      image_id: stickerId,
      app_id: appId,
      field: "shares",
    });
  });
});

describe("engagement abuse control", () => {
  it("404s for an unknown sticker", async () => {
    const res = await request(app)
      .post(`/api/stickers/${randomUUID()}/download`)
      .send({ app_id: appId, device_id: "device-x" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("STICKER_NOT_FOUND");
  });

  it("404s for a hidden sticker", async () => {
    const res = await request(app)
      .post(`/api/stickers/${hiddenId}/download`)
      .send({ app_id: appId, device_id: "device-x" });
    expect(res.status).toBe(404);
  });

  it("404s for a sticker from another tenant", async () => {
    const res = await request(app)
      .post(`/api/stickers/${otherStickerId}/download`)
      .send({ app_id: appId, device_id: "device-x" });
    expect(res.status).toBe(404);
  });

  it("400s on invalid params/body", async () => {
    const badId = await request(app)
      .post("/api/stickers/not-a-uuid/download")
      .send({ app_id: appId, device_id: "d" });
    expect(badId.status).toBe(400);

    const missingDevice = await request(app)
      .post(`/api/stickers/${stickerId}/download`)
      .send({ app_id: appId });
    expect(missingDevice.status).toBe(400);

    const longDevice = await request(app)
      .post(`/api/stickers/${stickerId}/download`)
      .send({ app_id: appId, device_id: "x".repeat(129) });
    expect(longDevice.status).toBe(400);

    const badApp = await request(app)
      .post(`/api/stickers/${stickerId}/download`)
      .send({ app_id: "nope", device_id: "d" });
    expect(badApp.status).toBe(400);
    expect(badApp.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rate-limits at 60/min per device_id", async () => {
    const device = "device-ratelimited";
    let last;
    for (let i = 0; i < 61; i += 1) {
      last = await request(app)
        .post(`/api/stickers/${stickerId}/download`)
        .send({ app_id: appId, device_id: device });
    }

    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe("RATE_LIMITED");
  });
});
