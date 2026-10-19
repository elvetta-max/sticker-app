import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { signAccessToken } from "../../src/lib/tokens.js";

/** In-memory Redis double: rate limiter (INCR/EXPIRE) + cache (GET/SET/SCAN/DEL). */
function createFakeRedis() {
  const kv = new Map();
  const counts = new Map();
  return {
    async ping() {
      return "PONG";
    },
    async get(key) {
      return kv.has(key) ? kv.get(key) : null;
    },
    async set(key, value) {
      kv.set(key, typeof value === "string" ? value : JSON.stringify(value));
      return "OK";
    },
    async incr(key) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
    async del(...keys) {
      let removed = 0;
      for (const key of keys) if (kv.delete(key)) removed += 1;
      return removed;
    },
    async scan(_cursor, _match, pattern) {
      const regex = new RegExp(
        `^${String(pattern)
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")}$`,
      );
      return ["0", [...kv.keys()].filter((key) => regex.test(key))];
    },
  };
}

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const USERNAME = `mod-admin-${suffix}`;

let app;
let prisma;
let token;
let appId;
let visibleA;
let visibleB;
let hiddenA;
let queueAppId;
let queueOtherAppId;

const createdImage = (app_id, name, is_hidden = false) =>
  prisma.image.create({
    data: {
      app_id,
      is_hidden,
      image_url: `https://example.test/${suffix}/${name}.webp`,
      cloudinary_public_id: `test/${suffix}/${name}`,
    },
  });

beforeAll(async () => {
  prisma = getPrisma();

  const admin = await prisma.admin.create({
    data: { username: USERNAME, password: "x".repeat(60) },
  });
  token = signAccessToken({ id: admin.id, username: USERNAME });

  appId = randomUUID();
  queueAppId = randomUUID();
  queueOtherAppId = randomUUID();
  for (const [id, name] of [
    [appId, "mod"],
    [queueAppId, "mod-queue"],
    [queueOtherAppId, "mod-queue-other"],
  ]) {
    await prisma.app.create({
      data: { id, name: `Moderation ${name}`, package_name: `test.mod.${name}.${suffix}` },
    });
  }

  visibleA = (await createdImage(appId, "a")).id;
  visibleB = (await createdImage(appId, "b")).id;
  hiddenA = (await createdImage(appId, "hidden", true)).id;

  const q1 = (await createdImage(queueAppId, "q1")).id;
  const q2 = (await createdImage(queueAppId, "q2")).id;
  const qo1 = (await createdImage(queueOtherAppId, "qo1")).id;

  const at = (minsAgo) => new Date(Date.now() - minsAgo * 60 * 1000);
  await prisma.report.createMany({
    data: [
      {
        app_id: queueAppId,
        device_id: `qd1-${suffix}`,
        image_id: q1,
        reason: "spam",
        status: "OPEN",
        created_at: at(1),
      },
      {
        app_id: queueAppId,
        device_id: `qd2-${suffix}`,
        image_id: q2,
        reason: "copyright",
        status: "OPEN",
        created_at: at(2),
      },
      {
        app_id: queueAppId,
        device_id: `qd3-${suffix}`,
        image_id: q1,
        reason: "inappropriate",
        status: "REVIEWED",
        created_at: at(3),
      },
      {
        app_id: queueOtherAppId,
        device_id: `qo-${suffix}`,
        image_id: qo1,
        reason: "other",
        status: "OPEN",
        created_at: at(4),
      },
    ],
  });

  app = createApp({ prisma, redis: createFakeRedis() });
});

afterAll(async () => {
  await prisma.app.deleteMany({
    where: { id: { in: [appId, queueAppId, queueOtherAppId] } },
  });
  await prisma.auditLog.deleteMany({ where: { admin_username: USERNAME } });
  await prisma.admin.deleteMany({ where: { username: USERNAME } });
  await disconnectPrisma();
});

const auth = (req) => req.set("Authorization", `Bearer ${token}`);

describe("POST /api/stickers/{id}/report", () => {
  it("files a report and stores the sticker's tenant", async () => {
    const device = `report-dev-${suffix}`;
    const res = await request(app)
      .post(`/api/stickers/${visibleA}/report`)
      .send({ device_id: device, reason: "spam" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });

    const row = await prisma.report.findFirst({ where: { device_id: device } });
    expect(row).toMatchObject({
      app_id: appId,
      image_id: visibleA,
      reason: "spam",
      status: "OPEN",
    });
  });

  it("is idempotent per device (bumps the existing row instead of duplicating)", async () => {
    const device = `report-dup-${suffix}`;
    await request(app)
      .post(`/api/stickers/${visibleA}/report`)
      .send({ device_id: device, reason: "spam" });
    const first = await prisma.report.findFirst({ where: { device_id: device } });

    const second = await request(app)
      .post(`/api/stickers/${visibleA}/report`)
      .send({ device_id: device, reason: "copyright" });
    expect(second.status).toBe(200);

    const rows = await prisma.report.findMany({ where: { device_id: device } });
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("copyright");
    expect(rows[0].created_at.getTime()).toBeGreaterThanOrEqual(first.created_at.getTime());
  });

  it("404s for a hidden or unknown sticker", async () => {
    expect(
      (
        await request(app)
          .post(`/api/stickers/${hiddenA}/report`)
          .send({ device_id: "d", reason: "spam" })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post(`/api/stickers/${randomUUID()}/report`)
          .send({ device_id: "d", reason: "spam" })
      ).status,
    ).toBe(404);
  });

  it("validates the params and body", async () => {
    const badId = await request(app)
      .post("/api/stickers/not-a-uuid/report")
      .send({ device_id: "d", reason: "spam" });
    expect(badId.status).toBe(400);

    const badReason = await request(app)
      .post(`/api/stickers/${visibleA}/report`)
      .send({ device_id: "d", reason: "rude" });
    expect(badReason.status).toBe(400);
    expect(badReason.body.error.code).toBe("VALIDATION_ERROR");

    const noDevice = await request(app)
      .post(`/api/stickers/${visibleA}/report`)
      .send({ reason: "spam" });
    expect(noDevice.status).toBe(400);
  });

  it("rate-limits at 10/min per device_id", async () => {
    const device = `report-rl-${suffix}`;
    let last;
    for (let i = 0; i < 11; i += 1) {
      last = await request(app)
        .post(`/api/stickers/${visibleB}/report`)
        .send({ device_id: device, reason: "spam" });
    }
    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("GET /api/admin/reports", () => {
  it("lists a tenant's queue newest-first, with image context and pagination", async () => {
    const first = await auth(
      request(app).get(`/api/admin/reports?app_id=${queueAppId}&status=OPEN&limit=1`),
    );
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(1);
    expect(first.body.data[0]).toMatchObject({
      app_id: queueAppId,
      status: "OPEN",
      reason: "spam",
    });
    expect(first.body.data[0].image).toMatchObject({
      id: expect.any(String),
      image_url: expect.any(String),
    });
    expect(first.body.next_cursor).toBeTruthy();

    const second = await auth(
      request(app).get(
        `/api/admin/reports?app_id=${queueAppId}&status=OPEN&limit=1&cursor=${first.body.next_cursor}`,
      ),
    );
    expect(second.body.data).toHaveLength(1);
    expect(second.body.data[0].reason).toBe("copyright");
    expect(second.body.next_cursor).toBeNull();
  });

  it("filters by status and never leaks another tenant's reports", async () => {
    const reviewed = await auth(
      request(app).get(`/api/admin/reports?app_id=${queueAppId}&status=REVIEWED`),
    );
    expect(reviewed.body.data.map((r) => r.status)).toEqual(["REVIEWED"]);

    const isolated = await auth(
      request(app).get(`/api/admin/reports?app_id=${queueOtherAppId}&status=OPEN`),
    );
    expect(isolated.body.data).toHaveLength(1);
    expect(isolated.body.data[0].app_id).toBe(queueOtherAppId);
  });

  it("requires auth, validates input, and 404s for unknown tenants", async () => {
    expect((await request(app).get(`/api/admin/reports?app_id=${queueAppId}`)).status).toBe(401);

    const badStatus = await auth(
      request(app).get(`/api/admin/reports?app_id=${queueAppId}&status=NOPE`),
    );
    expect(badStatus.status).toBe(400);

    const unknownApp = await auth(request(app).get(`/api/admin/reports?app_id=${randomUUID()}`));
    expect(unknownApp.status).toBe(404);
  });
});

describe("POST /api/admin/reports/{id}/(dismiss|resolve)", () => {
  it("dismisses and resolves reports", async () => {
    const open = await prisma.report.findFirst({
      where: { app_id: queueAppId, status: "OPEN", reason: "spam" },
    });
    const dismissed = await auth(request(app).post(`/api/admin/reports/${open.id}/dismiss`));
    expect(dismissed.status).toBe(200);
    expect(dismissed.body.data.status).toBe("DISMISSED");

    const other = await prisma.report.findFirst({
      where: { app_id: queueAppId, status: "OPEN" },
    });
    const resolved = await auth(request(app).post(`/api/admin/reports/${other.id}/resolve`));
    expect(resolved.status).toBe(200);
    expect(resolved.body.data.status).toBe("REVIEWED");

    expect(await prisma.report.count({ where: { app_id: queueAppId, status: "OPEN" } })).toBe(0);
  });

  it("requires auth, validates the id, and 404s for unknown reports", async () => {
    expect((await request(app).post(`/api/admin/reports/${randomUUID()}/dismiss`)).status).toBe(
      401,
    );

    const badId = await auth(request(app).post("/api/admin/reports/not-a-uuid/resolve"));
    expect(badId.status).toBe(400);

    const unknown = await auth(request(app).post(`/api/admin/reports/${randomUUID()}/resolve`));
    expect(unknown.status).toBe(404);
  });
});

describe("POST /api/admin/stickers/{id}/(hide|unhide)", () => {
  it("hides a sticker from all public surfaces, then restores it", async () => {
    // Warm the single-sticker cache so we can prove eviction.
    expect((await request(app).get(`/api/stickers/${visibleA}?app_id=${appId}`)).status).toBe(200);

    const hidden = await auth(request(app).post(`/api/admin/stickers/${visibleA}/hide`));
    expect(hidden.status).toBe(200);
    expect(hidden.body.data).toMatchObject({ id: visibleA, app_id: appId, is_hidden: true });

    expect((await request(app).get(`/api/stickers/${visibleA}?app_id=${appId}`)).status).toBe(404);
    const feed = await request(app).get(`/api/stickers?app_id=${appId}`);
    expect(feed.body.data.map((s) => s.id)).not.toContain(visibleA);
    expect(feed.body.data.map((s) => s.id)).toContain(visibleB);

    const restored = await auth(request(app).post(`/api/admin/stickers/${visibleA}/unhide`));
    expect(restored.body.data.is_hidden).toBe(false);
    expect((await request(app).get(`/api/stickers/${visibleA}?app_id=${appId}`)).status).toBe(200);
  });

  it("requires auth, validates the id, and 404s for unknown stickers", async () => {
    expect((await request(app).post(`/api/admin/stickers/${visibleA}/hide`)).status).toBe(401);

    const badId = await auth(request(app).post("/api/admin/stickers/not-a-uuid/hide"));
    expect(badId.status).toBe(400);

    const unknown = await auth(request(app).post(`/api/admin/stickers/${randomUUID()}/unhide`));
    expect(unknown.status).toBe(404);
  });
});
