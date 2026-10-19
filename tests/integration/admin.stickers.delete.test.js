import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { signAccessToken } from "../../src/lib/tokens.js";

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);

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

const USERNAME = `del_admin_${suffix}`;
let prisma;
let app;
let queue;
let token;
let appId;

beforeAll(async () => {
  prisma = getPrisma();
  const admin = await prisma.admin.create({
    data: { username: USERNAME, password: await bcrypt.hash("x", 4) },
  });
  token = signAccessToken({ id: admin.id, username: USERNAME });

  appId = randomUUID();
  await prisma.app.create({
    data: { id: appId, name: "Delete Test App", package_name: `test.delete.${suffix}` },
  });

  queue = createFakeQueue();
  app = createApp({ prisma, redis: fakeRedis, stickerQueue: queue });
});

afterAll(async () => {
  await prisma.image.deleteMany({ where: { app_id: appId } });
  await prisma.app.deleteMany({ where: { id: appId } });
  await prisma.auditLog.deleteMany({ where: { admin_username: USERNAME } });
  await prisma.admin.deleteMany({ where: { username: USERNAME } });
  await disconnectPrisma();
});

async function newSticker() {
  const publicId = `tenants/${appId}/${randomUUID()}`;
  const image = await prisma.image.create({
    data: {
      app_id: appId,
      image_url: `https://cdn.test/${randomUUID()}.webp`,
      cloudinary_public_id: publicId,
    },
  });
  return { image, publicId };
}

describe("DELETE /api/admin/stickers/{id}", () => {
  it("requires a bearer token", async () => {
    const { image } = await newSticker();
    const res = await request(app).delete(`/api/admin/stickers/${image.id}`);
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown sticker", async () => {
    const res = await request(app)
      .delete(`/api/admin/stickers/${randomUUID()}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("STICKER_NOT_FOUND");
  });

  it("deletes the row and enqueues asset destruction", async () => {
    const { image, publicId } = await newSticker();

    const res = await request(app)
      .delete(`/api/admin/stickers/${image.id}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const gone = await prisma.image.findUnique({ where: { id: image.id } });
    expect(gone).toBeNull();

    const enqueued = queue.added.at(-1);
    expect(enqueued.name).toBe("sticker:delete-asset");
    expect(enqueued.data).toEqual({ cloudinary_public_id: publicId });
  });
});
