import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import sharp from "sharp";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { signAccessToken } from "../../src/lib/tokens.js";

const fakeRedis = {
  ping: async () => "PONG",
  incr: async () => 1,
  expire: async () => 1,
  get: async () => null,
  set: async () => "OK",
  del: async () => 1,
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
    async getJob(id) {
      const found = added.find((job) => job.id === id);
      if (!found) return null;
      return {
        id: found.id,
        name: found.name,
        progress: 100,
        returnvalue: { image_id: "img-1" },
        failedReason: undefined,
        getState: async () => "completed",
      };
    },
  };
}

const USERNAME = `create_admin_${randomUUID().slice(0, 8)}`;
let prisma;
let app;
let queue;
let token;
let png;
let adminId;

beforeAll(async () => {
  prisma = getPrisma();
  const admin = await prisma.admin.create({
    data: { username: USERNAME, password: await bcrypt.hash("x", 4) },
  });
  adminId = admin.id;
  token = signAccessToken({ id: adminId, username: USERNAME });

  png = await sharp({
    create: { width: 128, height: 128, channels: 3, background: { r: 4, g: 5, b: 6 } },
  })
    .png()
    .toBuffer();

  queue = createFakeQueue();
  app = createApp({ prisma, redis: fakeRedis, stickerQueue: queue });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { admin_username: USERNAME } });
  await prisma.admin.deleteMany({ where: { username: USERNAME } });
  await disconnectPrisma();
});

const post = (t = token) =>
  request(app).post("/api/admin/stickers").set("Authorization", `Bearer ${t}`);

describe("POST /api/admin/stickers", () => {
  it("requires a bearer token", async () => {
    const res = await request(app).post("/api/admin/stickers");
    expect(res.status).toBe(401);
  });

  it("requires an image file", async () => {
    const res = await post().field("app_id", randomUUID());
    expect(res.status).toBe(400);
  });

  it("rejects a disallowed mime type", async () => {
    const res = await post()
      .field("app_id", randomUUID())
      .attach("image", Buffer.from("plain"), { filename: "a.txt", contentType: "text/plain" });
    expect(res.status).toBe(415);
  });

  it("rejects an image over 5 MB", async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0xff);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big, 0);
    const res = await post()
      .field("app_id", randomUUID())
      .attach("image", big, { filename: "big.png", contentType: "image/png" });
    expect(res.status).toBe(413);
  });

  it("rejects an invalid app_id", async () => {
    const res = await post()
      .field("app_id", "not-a-uuid")
      .attach("image", png, { filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("enqueues a job and returns 202 with a job id", async () => {
    const appId = randomUUID();
    const res = await post()
      .field("app_id", appId)
      .field("is_premium", "true")
      .field("tags", "cats,memes")
      .field("emojis", JSON.stringify(["😀"]))
      .attach("image", png, { filename: "a.png", contentType: "image/png" });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.job_id).toBe("job-1");

    const enqueued = queue.added.at(-1);
    expect(enqueued.name).toBe("sticker:upload");
    expect(enqueued.data).toMatchObject({
      app_id: appId,
      is_premium: true,
      is_animated: false,
      tags: ["cats", "memes"],
      emojis: ["😀"],
    });
    expect(typeof enqueued.data.image_base64).toBe("string");
    expect(enqueued.data.image_base64.length).toBeGreaterThan(0);
  });
});

describe("GET /api/admin/jobs/{job_id}", () => {
  it("requires a bearer token", async () => {
    const res = await request(app).get("/api/admin/jobs/job-1");
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown job", async () => {
    const res = await request(app)
      .get("/api/admin/jobs/nope")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns the job status and result", async () => {
    await post()
      .field("app_id", randomUUID())
      .attach("image", png, { filename: "a.png", contentType: "image/png" });

    const jobId = queue.added.at(-1).id;
    const res = await request(app)
      .get(`/api/admin/jobs/${jobId}`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      job_id: jobId,
      status: "completed",
      result: { image_id: "img-1" },
    });
  });
});
