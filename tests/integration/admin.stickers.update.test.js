import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import sharp from "sharp";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { signAccessToken } from "../../src/lib/tokens.js";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const tagOld = `old-${suffix}`;
const tagNew = `new-${suffix}`;

const fakeRedis = {
  ping: async () => "PONG",
  incr: async () => 1,
  expire: async () => 1,
  scan: async () => ["0", []],
  del: async () => 0,
};

function createFakeQueue() {
  const added = [];
  return {
    added,
    async add(name, data) {
      const job = { id: `job-${added.length + 1}`, name, data };
      added.push(job);
      return job;
    },
  };
}

const USERNAME = `upd_admin_${suffix}`;
let prisma;
let app;
let queue;
let token;
let appId;

async function newSticker({ is_premium = false, tags = [] } = {}) {
  return prisma.image.create({
    data: {
      app_id: appId,
      image_url: `https://cdn.test/${randomUUID()}.webp`,
      cloudinary_public_id: `tenants/${appId}/${randomUUID()}`,
      is_premium,
      tags: { connect: tags.map((name) => ({ name })) },
    },
    include: { tags: true },
  });
}

beforeAll(async () => {
  prisma = getPrisma();
  const admin = await prisma.admin.create({
    data: { username: USERNAME, password: await bcrypt.hash("x", 4) },
  });
  token = signAccessToken({ id: admin.id, username: USERNAME });

  appId = randomUUID();
  await prisma.app.create({
    data: { id: appId, name: "Update Test App", package_name: `test.update.${suffix}` },
  });
  await prisma.tag.create({ data: { name: tagOld } });
  await prisma.tag.create({ data: { name: tagNew } });

  queue = createFakeQueue();
  app = createApp({ prisma, redis: fakeRedis, stickerQueue: queue });
});

afterAll(async () => {
  await prisma.image.deleteMany({ where: { app_id: appId } });
  await prisma.app.deleteMany({ where: { id: appId } });
  await prisma.tag.deleteMany({ where: { name: { in: [tagOld, tagNew] } } });
  await prisma.auditLog.deleteMany({ where: { admin_username: USERNAME } });
  await prisma.admin.deleteMany({ where: { username: USERNAME } });
  await disconnectPrisma();
});

describe("PUT /api/admin/stickers/{id}", () => {
  it("requires a bearer token", async () => {
    const sticker = await newSticker();
    const res = await request(app).put(`/api/admin/stickers/${sticker.id}`).send({});
    expect(res.status).toBe(401);
  });

  it("rejects a malformed id", async () => {
    const res = await request(app)
      .put("/api/admin/stickers/bad-id")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown sticker", async () => {
    const res = await request(app)
      .put(`/api/admin/stickers/${randomUUID()}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ is_premium: true });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("STICKER_NOT_FOUND");
  });

  it("updates metadata (JSON) without touching the image", async () => {
    const sticker = await newSticker({ tags: [tagOld] });

    const res = await request(app)
      .put(`/api/admin/stickers/${sticker.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ is_premium: true, tags: [tagNew], emojis: ["🎯"] });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: sticker.id, is_premium: true, emojis: ["🎯"] });
    expect(res.body.data.tags).toEqual([tagNew]);
    expect(res.body.data.image_url).toBe(sticker.image_url);

    const row = await prisma.image.findUnique({
      where: { id: sticker.id },
      include: { tags: true },
    });
    expect(row.is_premium).toBe(true);
    expect(row.tags.map((t) => t.name)).toEqual([tagNew]);
  });

  it("leaves unspecified fields untouched", async () => {
    const sticker = await newSticker({ is_premium: true, tags: [tagOld] });
    const res = await request(app)
      .put(`/api/admin/stickers/${sticker.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ emojis: ["🆕"] });

    expect(res.status).toBe(200);
    expect(res.body.data.is_premium).toBe(true);
    expect(res.body.data.tags).toEqual([tagOld]);
  });

  it("accepts multipart metadata without a new image", async () => {
    const sticker = await newSticker({ is_premium: false });
    const res = await request(app)
      .put(`/api/admin/stickers/${sticker.id}`)
      .set("Authorization", `Bearer ${token}`)
      .field("is_premium", "true");

    expect(res.status).toBe(200);
    expect(res.body.data.is_premium).toBe(true);
  });

  it("enqueues a replace job when a new image is provided", async () => {
    const sticker = await newSticker({ is_premium: true, tags: [tagOld] });
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 1, b: 1 } },
    })
      .png()
      .toBuffer();

    const res = await request(app)
      .put(`/api/admin/stickers/${sticker.id}`)
      .set("Authorization", `Bearer ${token}`)
      .field("is_premium", "false")
      .attach("image", png, { filename: "new.png", contentType: "image/png" });

    expect(res.status).toBe(202);
    expect(res.body.job_id).toBeTruthy();

    const enqueued = queue.added.at(-1);
    expect(enqueued.name).toBe("sticker:replace");
    expect(enqueued.data).toMatchObject({
      image_id: sticker.id,
      is_premium: false,
      tags: [tagOld],
    });
  });
});
