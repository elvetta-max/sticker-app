import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { signAccessToken } from "../../src/lib/tokens.js";
import { dispatchBroadcast } from "../../src/workers/notification.worker.js";
import { utcDay } from "../../src/lib/notification.js";

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

/** Captures enqueued campaigns and answers the status lookup. */
function createNotificationQueueStub() {
  const jobs = new Map();
  return {
    jobs,
    async add(name, data, opts) {
      const job = { id: opts.jobId, name, data, opts };
      jobs.set(opts.jobId, job);
      return job;
    },
    async getJob(id) {
      if (!jobs.has(id)) return null;
      return {
        id,
        getState: async () => "completed",
        returnvalue: { sent: 3, failed: 0 },
        failedReason: null,
      };
    },
  };
}

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const USERNAME = `notif-admin-${suffix}`;
const DAY_MS = 24 * 60 * 60 * 1000;

let app;
let prisma;
let queue;
let token;
let appId;
let otherAppId;
let active;
let inactive;
let disabled;
let noToken;
let capped;
let dead;
let other;
const deadToken = `tok-dead-${suffix}`;

beforeAll(async () => {
  prisma = getPrisma();

  const admin = await prisma.admin.create({
    data: { username: USERNAME, password: "x".repeat(60) },
  });
  token = signAccessToken({ id: admin.id, username: USERNAME });

  appId = randomUUID();
  otherAppId = randomUUID();
  await prisma.app.create({
    data: { id: appId, name: "Notifications App", package_name: `test.notif.${suffix}` },
  });
  await prisma.app.create({
    data: {
      id: otherAppId,
      name: "Notifications Other",
      package_name: `test.notif.other.${suffix}`,
    },
  });

  const makeDevice = (device_id, data) =>
    prisma.deviceProfile.create({ data: { device_id, app_id: appId, ...data } });

  active = `d-active-${suffix}`;
  inactive = `d-inactive-${suffix}`;
  disabled = `d-disabled-${suffix}`;
  noToken = `d-notoken-${suffix}`;
  capped = `d-capped-${suffix}`;
  dead = `d-dead-${suffix}`;
  other = `d-other-${suffix}`;

  await makeDevice(active, { fcm_token: `tok-active-${suffix}` });
  await makeDevice(inactive, {
    fcm_token: `tok-inactive-${suffix}`,
    last_active_date: new Date(Date.now() - 5 * DAY_MS),
  });
  await makeDevice(disabled, { fcm_token: `tok-disabled-${suffix}`, notifications_enabled: false });
  await makeDevice(noToken, { fcm_token: null });
  await makeDevice(capped, { fcm_token: `tok-capped-${suffix}` });
  await makeDevice(dead, { fcm_token: deadToken });
  await prisma.deviceProfile.create({
    data: { device_id: other, app_id: otherAppId, fcm_token: `tok-other-${suffix}` },
  });

  await prisma.notificationLog.create({
    data: { app_id: appId, device_id: capped, type: "BROADCAST", day: utcDay(), status: "SENT" },
  });

  queue = createNotificationQueueStub();
  app = createApp({ prisma, redis: createFakeRedis(), notificationQueue: queue });
});

afterAll(async () => {
  await prisma.app.deleteMany({ where: { id: { in: [appId, otherAppId] } } });
  await prisma.auditLog.deleteMany({ where: { admin_username: USERNAME } });
  await prisma.admin.deleteMany({ where: { username: USERNAME } });
  await disconnectPrisma();
});

const auth = (req) => req.set("Authorization", `Bearer ${token}`);

describe("POST /api/admin/notifications/broadcast", () => {
  it("resolves the ALL audience and enqueues an async campaign (202)", async () => {
    const res = await auth(request(app).post("/api/admin/notifications/broadcast")).send({
      app_id: appId,
      target_type: "ALL",
      title: "New stickers!",
      body: "Fresh packs just landed.",
    });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.campaign_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.targeted_devices_count).toBe(4);

    const job = queue.jobs.get(res.body.campaign_id);
    expect(job.name).toBe("notification:broadcast");
    expect(job.data).toMatchObject({
      campaign_id: res.body.campaign_id,
      app_id: appId,
      target_type: "ALL",
      title: "New stickers!",
      body: "Fresh packs just landed.",
    });
    expect(new Set(job.data.device_ids)).toEqual(new Set([active, inactive, capped, dead]));
  });

  it("narrows the INACTIVE audience to devices idle for 3+ days", async () => {
    const res = await auth(request(app).post("/api/admin/notifications/broadcast")).send({
      app_id: appId,
      target_type: "INACTIVE",
      title: "We miss you",
      body: "Come back for new stickers.",
    });

    expect(res.status).toBe(202);
    expect(res.body.targeted_devices_count).toBe(1);
    expect(queue.jobs.get(res.body.campaign_id).data.device_ids).toEqual([inactive]);
  });

  it("requires admin auth", async () => {
    const res = await request(app)
      .post("/api/admin/notifications/broadcast")
      .send({ app_id: appId, target_type: "ALL", title: "x", body: "y" });
    expect(res.status).toBe(401);
  });

  it("validates the body (SEARCH_BASED is not a manual target) and the tenant", async () => {
    const badTarget = await auth(request(app).post("/api/admin/notifications/broadcast")).send({
      app_id: appId,
      target_type: "SEARCH_BASED",
      title: "x",
      body: "y",
    });
    expect(badTarget.status).toBe(400);
    expect(badTarget.body.error.code).toBe("VALIDATION_ERROR");

    const missingBody = await auth(request(app).post("/api/admin/notifications/broadcast")).send({
      app_id: appId,
      target_type: "ALL",
      title: "x",
    });
    expect(missingBody.status).toBe(400);

    const unknownApp = await auth(request(app).post("/api/admin/notifications/broadcast")).send({
      app_id: randomUUID(),
      target_type: "ALL",
      title: "x",
      body: "y",
    });
    expect(unknownApp.status).toBe(404);
  });
});

describe("GET /api/admin/notifications/{campaign_id}", () => {
  it("returns campaign status by id", async () => {
    const created = await auth(request(app).post("/api/admin/notifications/broadcast")).send({
      app_id: appId,
      target_type: "ALL",
      title: "x",
      body: "y",
    });

    const res = await auth(
      request(app).get(`/api/admin/notifications/${created.body.campaign_id}`),
    );
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "completed", result: { sent: 3, failed: 0 } });
  });

  it("404s for an unknown campaign and requires auth", async () => {
    expect((await auth(request(app).get(`/api/admin/notifications/${randomUUID()}`))).status).toBe(
      404,
    );
    expect((await request(app).get(`/api/admin/notifications/${randomUUID()}`)).status).toBe(401);
  });
});

describe("dispatchBroadcast against the database", () => {
  it("skips disabled/tokenless/other-tenant devices, honors the cap, and clears dead tokens", async () => {
    const sender = {
      batches: [],
      async sendBatch(tokens) {
        this.batches.push(tokens);
        return {
          responses: tokens.map((t) =>
            t === deadToken ? { success: false, dead: true } : { success: true },
          ),
        };
      },
    };

    const summary = await dispatchBroadcast({
      prisma,
      sender,
      data: {
        campaign_id: randomUUID(),
        app_id: appId,
        title: "Hi",
        body: "There",
        device_ids: [active, inactive, disabled, noToken, capped, dead, other],
      },
    });

    expect(summary).toMatchObject({
      eligible: 4,
      skipped_capped: 1,
      sent: 2,
      failed: 1,
      dead_tokens: 1,
    });

    const cleared = await prisma.deviceProfile.findUnique({ where: { device_id: dead } });
    expect(cleared.fcm_token).toBeNull();

    const loggedIds = (
      await prisma.notificationLog.findMany({ where: { day: utcDay(), app_id: appId } })
    ).map((row) => row.device_id);
    expect(new Set(loggedIds)).toEqual(new Set([capped, active, inactive, dead]));
  });
});
