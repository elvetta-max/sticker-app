import { describe, it, expect, beforeAll, afterAll } from "vitest";
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { processStickerJob } from "../../src/workers/sticker.worker.js";
import { StickerJob } from "../../src/queues/sticker.queue.js";

const fixture = (name) => readFile(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)));

function createMockCloudinary() {
  let counter = 0;
  const uploads = [];
  const destroys = [];
  return {
    uploads,
    destroys,
    async uploadSticker({ appId, buffer }) {
      const publicId = `tenants/${appId}/mock-${++counter}`;
      uploads.push({ publicId, bytes: buffer.length });
      return { url: `https://cdn.test/${publicId}.webp`, publicId };
    },
    async destroySticker(publicId) {
      destroys.push(publicId);
    },
  };
}

function createMockRedis() {
  const zincrbyCalls = [];
  const deletedKeys = [];
  const store = new Set();
  const glob = (pattern) =>
    new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return {
    zincrbyCalls,
    deletedKeys,
    seed(key) {
      store.add(key);
    },
    async zincrby(key, delta, member) {
      zincrbyCalls.push({ key, delta, member });
      return delta;
    },
    async scan(_cursor, _match, pattern) {
      return ["0", [...store].filter((key) => glob(pattern).test(key))];
    },
    async del(...keys) {
      let removed = 0;
      for (const key of keys) {
        if (store.delete(key)) {
          deletedKeys.push(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const tagA = `wk-a-${suffix}`;
const tagB = `wk-b-${suffix}`;

let prisma;
let cloudinary;
let appId;
let pngBase64;

beforeAll(async () => {
  prisma = getPrisma();
  cloudinary = createMockCloudinary();
  appId = randomUUID();

  await prisma.app.create({
    data: { id: appId, name: "Worker Test App", package_name: `test.worker.${suffix}` },
  });

  const png = await sharp({
    create: { width: 300, height: 300, channels: 4, background: { r: 5, g: 60, b: 120, alpha: 1 } },
  })
    .png()
    .toBuffer();
  pngBase64 = png.toString("base64");
});

afterAll(async () => {
  await prisma.image.deleteMany({ where: { app_id: appId } });
  await prisma.app.deleteMany({ where: { id: appId } });
  await prisma.tag.deleteMany({ where: { name: { in: [tagA, tagB] } } });
  await disconnectPrisma();
});

describe("sticker worker — upload", () => {
  it("processes an image, uploads it and persists a sticker with tags", async () => {
    const result = await processStickerJob(
      {
        name: StickerJob.UPLOAD,
        data: {
          app_id: appId,
          image_base64: pngBase64,
          is_premium: true,
          emojis: ["😀", "🎉"],
          tags: [tagA, tagB],
        },
      },
      { prisma, cloudinary },
    );

    expect(result.image_id).toBeTruthy();
    expect(result.cloudinary_public_id).toContain(`tenants/${appId}`);

    const image = await prisma.image.findUnique({
      where: { id: result.image_id },
      include: { tags: true },
    });
    expect(image.app_id).toBe(appId);
    expect(image.is_premium).toBe(true);
    expect(image.is_animated).toBe(false);
    expect(image.emojis).toEqual(["😀", "🎉"]);
    expect(image.tags.map((t) => t.name).sort()).toEqual([tagA, tagB].sort());
    expect(cloudinary.uploads).toHaveLength(1);
  });

  it("rejects a job for an unknown tenant", async () => {
    await expect(
      processStickerJob(
        { name: StickerJob.UPLOAD, data: { app_id: randomUUID(), image_base64: pngBase64 } },
        { prisma, cloudinary },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects an animated image with too many frames", async () => {
    const gif = (await fixture("animated-40.gif")).toString("base64");
    await expect(
      processStickerJob(
        { name: StickerJob.UPLOAD, data: { app_id: appId, image_base64: gif, is_animated: true } },
        { prisma, cloudinary },
      ),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("sticker worker — replace", () => {
  it("replaces the asset, updates the row and destroys the old asset", async () => {
    const created = await processStickerJob(
      { name: StickerJob.UPLOAD, data: { app_id: appId, image_base64: pngBase64, tags: [tagA] } },
      { prisma, cloudinary },
    );
    const oldPublicId = created.cloudinary_public_id;

    const updated = await processStickerJob(
      {
        name: StickerJob.REPLACE,
        data: { image_id: created.image_id, image_base64: pngBase64, tags: [tagB] },
      },
      { prisma, cloudinary },
    );

    expect(updated.image_url).not.toBe(created.image_url);
    expect(cloudinary.destroys).toContain(oldPublicId);

    const image = await prisma.image.findUnique({
      where: { id: created.image_id },
      include: { tags: true },
    });
    expect(image.tags.map((t) => t.name)).toEqual([tagB]);
  });
});

describe("sticker worker — delete asset", () => {
  it("destroys the Cloudinary asset by public id", async () => {
    await processStickerJob(
      { name: StickerJob.DELETE_ASSET, data: { cloudinary_public_id: "tenants/x/y" } },
      { prisma, cloudinary },
    );
    expect(cloudinary.destroys).toContain("tenants/x/y");
  });
});

describe("sticker worker — increment counter", () => {
  it("increments the counter and nudges the trending ZSET", async () => {
    const redis = createMockRedis();
    const created = await processStickerJob(
      { name: StickerJob.UPLOAD, data: { app_id: appId, image_base64: pngBase64 } },
      { prisma, cloudinary },
    );

    const result = await processStickerJob(
      {
        name: StickerJob.INCREMENT_COUNTER,
        data: { image_id: created.image_id, app_id: appId, field: "downloads" },
      },
      { prisma, cloudinary, redis },
    );

    expect(result.downloads).toBe(1);
    const row = await prisma.image.findUnique({ where: { id: created.image_id } });
    expect(row.downloads).toBe(1);
    expect(row.shares).toBe(0);

    expect(redis.zincrbyCalls).toHaveLength(1);
    expect(redis.zincrbyCalls[0].key).toBe(`trending:stickers:${appId}`);
    expect(redis.zincrbyCalls[0].member).toBe(created.image_id);
    expect(redis.zincrbyCalls[0].delta).toBeGreaterThan(0);
  });

  it("increments shares and skips Redis when none is provided", async () => {
    const created = await processStickerJob(
      { name: StickerJob.UPLOAD, data: { app_id: appId, image_base64: pngBase64 } },
      { prisma, cloudinary },
    );

    const result = await processStickerJob(
      {
        name: StickerJob.INCREMENT_COUNTER,
        data: { image_id: created.image_id, app_id: appId, field: "shares" },
      },
      { prisma, cloudinary },
    );

    expect(result.shares).toBe(1);
  });

  it("rejects an unknown counter field", async () => {
    await expect(
      processStickerJob(
        {
          name: StickerJob.INCREMENT_COUNTER,
          data: { image_id: randomUUID(), app_id: appId, field: "views" },
        },
        { prisma, cloudinary },
      ),
    ).rejects.toBeTruthy();
  });
});

describe("sticker worker — cache invalidation", () => {
  it("evicts the app's feed pages after an upload", async () => {
    const redis = createMockRedis();
    redis.seed(`stickers:${appId}:stale-hash`);

    await processStickerJob(
      { name: StickerJob.UPLOAD, data: { app_id: appId, image_base64: pngBase64 } },
      { prisma, cloudinary, redis },
    );

    expect(redis.deletedKeys).toContain(`stickers:${appId}:stale-hash`);
  });

  it("evicts feed pages and the single-sticker key after a replace", async () => {
    const created = await processStickerJob(
      { name: StickerJob.UPLOAD, data: { app_id: appId, image_base64: pngBase64 } },
      { prisma, cloudinary },
    );

    const redis = createMockRedis();
    redis.seed(`stickers:${appId}:stale-hash`);
    redis.seed(`sticker:${created.image_id}`);

    await processStickerJob(
      {
        name: StickerJob.REPLACE,
        data: { image_id: created.image_id, image_base64: pngBase64 },
      },
      { prisma, cloudinary, redis },
    );

    expect(redis.deletedKeys).toContain(`stickers:${appId}:stale-hash`);
    expect(redis.deletedKeys).toContain(`sticker:${created.image_id}`);
  });
});
