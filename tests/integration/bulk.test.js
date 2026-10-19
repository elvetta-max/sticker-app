import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { signAccessToken } from "../../src/lib/tokens.js";
import { buildZip } from "../fixtures/zip-builder.js";

const fakeRedis = {
  ping: async () => "PONG",
  incr: async () => 1,
  expire: async () => 1,
  get: async () => null,
  set: async () => "OK",
  del: async () => 1,
  scan: async () => ["0", []],
};

/** Fake FlowProducer capturing the tree the endpoint builds. */
function createFakeFlowProducer() {
  const trees = [];
  return {
    trees,
    async add(tree) {
      trees.push(tree);
      return { job: { id: tree.opts.jobId }, children: [] };
    },
  };
}

const USERNAME = `bulk_admin_${randomUUID().slice(0, 8)}`;
let prisma;
let app;
let flowProducer;
let token;
let png;
let webp;
let appId;

beforeAll(async () => {
  prisma = getPrisma();
  const admin = await prisma.admin.create({
    data: { username: USERNAME, password: "x".repeat(60) },
  });
  token = signAccessToken({ id: admin.id, username: USERNAME });

  appId = randomUUID();
  await prisma.app.create({
    data: {
      id: appId,
      name: "Bulk Test App",
      package_name: `test.bulk.${randomUUID().slice(0, 8)}`,
    },
  });

  png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .png()
    .toBuffer();
  webp = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 9, g: 8, b: 7, alpha: 1 } },
  })
    .webp()
    .toBuffer();

  flowProducer = createFakeFlowProducer();
  app = createApp({ prisma, redis: fakeRedis, flowProducer });
});

afterAll(async () => {
  await prisma.app.deleteMany({ where: { id: appId } });
  await prisma.auditLog.deleteMany({ where: { admin_username: USERNAME } });
  await prisma.admin.deleteMany({ where: { username: USERNAME } });
  await disconnectPrisma();
});

const post = (t = token) =>
  request(app).post("/api/admin/stickers/bulk").set("Authorization", `Bearer ${t}`);

const attachZip = (req, buffer, filename = "stickers.zip") =>
  req.attach("zip", buffer, { filename, contentType: "application/zip" });

describe("POST /api/admin/stickers/bulk", () => {
  it("requires admin auth", async () => {
    const res = await attachZip(
      request(app).post("/api/admin/stickers/bulk").field("app_id", appId),
      buildZip([{ name: "a.png", data: png }]),
    );
    expect(res.status).toBe(401);
  });

  it("requires a zip file", async () => {
    const res = await post().field("app_id", appId);
    expect(res.status).toBe(400);
  });

  it("validates the app_id", async () => {
    const res = await attachZip(
      post().field("app_id", "not-a-uuid"),
      buildZip([{ name: "a.png", data: png }]),
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("404s for an unknown tenant", async () => {
    const res = await attachZip(
      post().field("app_id", randomUUID()),
      buildZip([{ name: "a.png", data: png }]),
    );
    expect(res.status).toBe(404);
  });

  it("enqueues one child upload per image and returns 202", async () => {
    const zip = buildZip([
      { name: "set/a.png", data: png },
      { name: "set/b.webp", data: webp, method: 8 },
      { name: "readme.txt", data: Buffer.from("ignored") },
      { name: "set/", data: Buffer.alloc(0) },
    ]);

    const res = await attachZip(
      post()
        .field("app_id", appId)
        .field("is_premium", "true")
        .field("tags", "cats,memes")
        .field("emojis", JSON.stringify(["😀"])),
      zip,
    );

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.job_id).toBeTruthy();
    expect(res.body.total).toBe(2);

    const tree = flowProducer.trees.at(-1);
    expect(tree.name).toBe("sticker:bulk");
    expect(tree.data).toMatchObject({
      app_id: appId,
      total: 2,
      is_premium: true,
      tags: ["cats", "memes"],
      emojis: ["😀"],
    });
    expect(tree.data.entries.map((e) => e.filename)).toEqual(["set/a.png", "set/b.webp"]);
    expect(tree.children).toHaveLength(2);
    expect(tree.children[0].data).toMatchObject({
      app_id: appId,
      is_premium: true,
      tags: ["cats", "memes"],
      emojis: ["😀"],
      image_base64: png.toString("base64"),
    });
  });

  it("rejects zip-slip paths and archives without images", async () => {
    const slip = await attachZip(
      post().field("app_id", appId),
      buildZip([{ name: "../evil.png", data: png }]),
    );
    expect(slip.status).toBe(400);
    expect(slip.body.error.message).toMatch(/Unsafe path/);

    const noImages = await attachZip(
      post().field("app_id", appId),
      buildZip([{ name: "notes.txt", data: Buffer.from("hi") }]),
    );
    expect(noImages.status).toBe(400);
    expect(noImages.body.error.message).toMatch(/no supported images/i);
  });

  it("rejects non-image bytes even when the extension is allowed", async () => {
    const res = await attachZip(
      post().field("app_id", appId),
      buildZip([{ name: "fake.png", data: Buffer.from("not really a png") }]),
    );
    expect(res.status).toBe(415);
    expect(res.body.error.message).toMatch(/not a supported image/i);
  });

  it("rejects archives over the 200-image cap", async () => {
    const zip = buildZip(Array.from({ length: 201 }, (_, i) => ({ name: `${i}.png`, data: png })));
    const res = await attachZip(post().field("app_id", appId), zip);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/more than 200 files/);
  });
});
