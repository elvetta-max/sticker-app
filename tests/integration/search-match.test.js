import { describe, it, expect, beforeAll, afterAll } from "vitest";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import * as notificationWorker from "../../src/workers/notification.worker.js";
import { processStickerJob } from "../../src/workers/sticker.worker.js";
import { StickerJob } from "../../src/queues/sticker.queue.js";
import { utcDay } from "../../src/lib/notification.js";
import { normalizeKeyword } from "../../src/lib/normalize.js";

const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours) => new Date(Date.now() - hours * HOUR_MS);

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const rawTag = `CaTs-${suffix}`;
const normalizedTag = normalizeKeyword(rawTag);

const eligibleDevice = `sm-eligible-${suffix}`;
const activeDevice = `sm-active-${suffix}`;
const disabledDevice = `sm-disabled-${suffix}`;
const noTokenDevice = `sm-notoken-${suffix}`;
const oldSearchDevice = `sm-old-${suffix}`;
const otherTenantDevice = `sm-other-${suffix}`;

const eligibleToken = `tok-eligible-${suffix}`;

let prisma;
let appId;
let otherAppId;
let imageId;
let pngBase64;

function createSender(behavior = () => ({ success: true })) {
  const batches = [];
  return {
    batches,
    async sendBatch(tokens, message) {
      batches.push({ tokens: [...tokens], message });
      return { responses: tokens.map((token) => behavior(token, message)) };
    },
  };
}

function createQueueStub({ throws = false } = {}) {
  const adds = [];
  return {
    adds,
    async add(name, data, opts) {
      if (throws) throw new Error("queue down");
      adds.push({ name, data, opts });
      return { id: opts?.jobId };
    },
  };
}

function createMockCloudinary() {
  let counter = 0;
  return {
    async uploadSticker({ appId: ownerAppId }) {
      const publicId = `tenants/${ownerAppId}/mock-${++counter}`;
      return { url: `https://cdn.test/${publicId}.webp`, publicId };
    },
    async destroySticker() {},
  };
}

beforeAll(async () => {
  prisma = getPrisma();
  appId = randomUUID();
  otherAppId = randomUUID();

  await prisma.app.create({
    data: { id: appId, name: "Search Match App", package_name: `test.searchmatch.${suffix}` },
  });
  await prisma.app.create({
    data: {
      id: otherAppId,
      name: "Search Match Other",
      package_name: `test.searchmatch.other.${suffix}`,
    },
  });

  const tag = await prisma.tag.create({ data: { name: rawTag } });
  const image = await prisma.image.create({
    data: {
      app_id: appId,
      image_url: "https://cdn.test/seed.webp",
      cloudinary_public_id: `tenants/${appId}/seed`,
      emojis: [],
      tags: { connect: [{ id: tag.id }] },
    },
  });
  imageId = image.id;

  const makeDevice = (device_id, data) =>
    prisma.deviceProfile.create({ data: { device_id, app_id: appId, ...data } });

  // Eligible: searched 2h ago, last checked in 5h ago (before the search).
  await makeDevice(eligibleDevice, {
    fcm_token: eligibleToken,
    last_active_date: hoursAgo(5),
  });
  // Active after searching: must be excluded.
  await makeDevice(activeDevice, {
    fcm_token: `tok-active-${suffix}`,
    last_active_date: hoursAgo(1),
  });
  // Notifications disabled: excluded.
  await makeDevice(disabledDevice, {
    fcm_token: `tok-disabled-${suffix}`,
    notifications_enabled: false,
    last_active_date: hoursAgo(5),
  });
  // No FCM token: excluded.
  await makeDevice(noTokenDevice, { fcm_token: null, last_active_date: hoursAgo(5) });
  // Search outside the 48h window: excluded.
  await makeDevice(oldSearchDevice, {
    fcm_token: `tok-old-${suffix}`,
    last_active_date: hoursAgo(60),
  });
  // Matching search, but in another tenant: excluded.
  await prisma.deviceProfile.create({
    data: {
      device_id: otherTenantDevice,
      app_id: otherAppId,
      fcm_token: `tok-other-${suffix}`,
      last_active_date: hoursAgo(5),
    },
  });

  const recent = hoursAgo(2);
  await prisma.searchQuery.createMany({
    data: [
      { app_id: appId, device_id: eligibleDevice, keyword: normalizedTag, created_at: recent },
      { app_id: appId, device_id: activeDevice, keyword: normalizedTag, created_at: recent },
      { app_id: appId, device_id: disabledDevice, keyword: normalizedTag, created_at: recent },
      { app_id: appId, device_id: noTokenDevice, keyword: normalizedTag, created_at: recent },
      {
        app_id: appId,
        device_id: oldSearchDevice,
        keyword: normalizedTag,
        created_at: hoursAgo(49),
      },
      {
        app_id: otherAppId,
        device_id: otherTenantDevice,
        keyword: normalizedTag,
        created_at: recent,
      },
    ],
  });

  const png = await sharp({
    create: { width: 300, height: 300, channels: 4, background: { r: 10, g: 90, b: 30, alpha: 1 } },
  })
    .png()
    .toBuffer();
  pngBase64 = png.toString("base64");
});

afterAll(async () => {
  await prisma.image.deleteMany({ where: { app_id: { in: [appId, otherAppId] } } });
  await prisma.tag.deleteMany({ where: { name: { startsWith: `CaTs-${suffix}` } } });
  await prisma.tag.deleteMany({ where: { name: { startsWith: `sm-upload-${suffix}` } } });
  await prisma.app.deleteMany({ where: { id: { in: [appId, otherAppId] } } });
  await disconnectPrisma();
});

describe("dispatchSearchMatch against the database", () => {
  it("pushes only to devices that searched a matching tag and have been inactive since", async () => {
    const sender = createSender();
    const redis = {
      async zscore() {
        return null;
      },
    };

    const summary = await notificationWorker.dispatchSearchMatch({
      prisma,
      sender,
      redis,
      data: { image_id: imageId, app_id: appId },
    });

    expect(summary).toEqual({
      image_id: imageId,
      matched: 4,
      eligible: 1,
      sent: 1,
      failed: 0,
      skipped_capped: 0,
      dead_tokens: 0,
    });

    expect(sender.batches).toHaveLength(1);
    expect(sender.batches[0].tokens).toEqual([eligibleToken]);
    expect(sender.batches[0].message).toEqual({
      title: `New stickers for "${normalizedTag}"`,
      body: `Fresh "${normalizedTag}" stickers just landed. Tap to see them.`,
      data: { type: "SEARCH_MATCH", image_id: imageId, keyword: normalizedTag },
    });

    const log = await prisma.notificationLog.findFirst({
      where: { device_id: eligibleDevice, day: utcDay() },
    });
    expect(log).not.toBeNull();
    expect(log).toMatchObject({
      app_id: appId,
      device_id: eligibleDevice,
      type: "SEARCH_MATCH",
      status: "SENT",
      image_id: imageId,
      keyword: normalizedTag,
    });

    // The excluded devices never got a log row.
    const loggedDevices = (
      await prisma.notificationLog.findMany({ where: { app_id: appId, day: utcDay() } })
    ).map((row) => row.device_id);
    expect(loggedDevices).toEqual([eligibleDevice]);
  });

  it("does not re-send to the same device on a second event the same day (global cap)", async () => {
    const sender = createSender();

    const summary = await notificationWorker.dispatchSearchMatch({
      prisma,
      sender,
      redis: {
        async zscore() {
          return null;
        },
      },
      data: { image_id: imageId, app_id: appId },
    });

    expect(summary).toMatchObject({ matched: 4, eligible: 1, sent: 0, skipped_capped: 1 });
    expect(sender.batches).toHaveLength(0);
  });

  it("returns a zero summary for a hidden image", async () => {
    const hidden = await prisma.image.create({
      data: {
        app_id: appId,
        image_url: "https://cdn.test/hidden.webp",
        cloudinary_public_id: `tenants/${appId}/hidden`,
        is_hidden: true,
        emojis: [],
      },
    });
    const sender = createSender();

    const summary = await notificationWorker.dispatchSearchMatch({
      prisma,
      sender,
      data: { image_id: hidden.id, app_id: appId },
    });

    expect(summary).toEqual({
      image_id: hidden.id,
      matched: 0,
      eligible: 0,
      sent: 0,
      failed: 0,
      skipped_capped: 0,
      dead_tokens: 0,
    });
    expect(sender.batches).toHaveLength(0);
  });
});

describe("sticker upload triggers SEARCH_MATCH", () => {
  it("enqueues a notification job with a colon-free job id when the upload has tags", async () => {
    const queue = createQueueStub();
    const cloudinary = createMockCloudinary();

    const result = await processStickerJob(
      {
        name: StickerJob.UPLOAD,
        data: { app_id: appId, image_base64: pngBase64, tags: [rawTag] },
      },
      { prisma, cloudinary, notificationQueue: queue },
    );

    expect(result.image_id).toBeTruthy();
    expect(queue.adds).toHaveLength(1);
    expect(queue.adds[0]).toEqual({
      name: "notification:search-match",
      data: { image_id: result.image_id, app_id: appId },
      opts: { jobId: `search-match-${result.image_id}` },
    });
    expect(queue.adds[0].opts.jobId).not.toContain(":");
  });

  it("does not enqueue when the upload has no tags", async () => {
    const queue = createQueueStub();
    const cloudinary = createMockCloudinary();

    const result = await processStickerJob(
      {
        name: StickerJob.UPLOAD,
        data: { app_id: appId, image_base64: pngBase64, tags: [] },
      },
      { prisma, cloudinary, notificationQueue: queue },
    );

    expect(result.image_id).toBeTruthy();
    expect(queue.adds).toHaveLength(0);
  });

  it("does not enqueue when no notification queue is injected", async () => {
    const cloudinary = createMockCloudinary();

    const result = await processStickerJob(
      {
        name: StickerJob.UPLOAD,
        data: { app_id: appId, image_base64: pngBase64, tags: [rawTag] },
      },
      { prisma, cloudinary },
    );

    expect(result.image_id).toBeTruthy();
  });

  it("still completes the upload when enqueueing the notification job fails", async () => {
    const queue = createQueueStub({ throws: true });
    const cloudinary = createMockCloudinary();

    const result = await processStickerJob(
      {
        name: StickerJob.UPLOAD,
        data: { app_id: appId, image_base64: pngBase64, tags: [rawTag] },
      },
      { prisma, cloudinary, notificationQueue: queue },
    );

    expect(result.image_id).toBeTruthy();
    const image = await prisma.image.findUnique({ where: { id: result.image_id } });
    expect(image).not.toBeNull();
  });
});
