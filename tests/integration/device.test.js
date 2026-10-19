import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";

const SYNC_MESSAGE = "Device profile and FCM token synchronized successfully.";

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

const utcDay = (date) => new Date(date).toISOString().slice(0, 10);
const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date();
const yesterday = new Date(now.getTime() - DAY_MS);
const threeDaysAgo = new Date(now.getTime() - 3 * DAY_MS);

const suffix = randomUUID().replace(/-/g, "").slice(0, 12);
const D = {
  create: `dev-create-${suffix}`,
  throttle: `dev-throttle-${suffix}`,
  newday: `dev-newday-${suffix}`,
  brk: `dev-break-${suffix}`,
  unknown: `dev-unknown-${suffix}`,
  get: `dev-get-${suffix}`,
};

let app;
let prisma;
let appId;
let otherAppId;

beforeAll(async () => {
  prisma = getPrisma();
  appId = randomUUID();
  otherAppId = randomUUID();

  await prisma.app.create({
    data: { id: appId, name: "Device Test App", package_name: `test.device.${suffix}` },
  });
  await prisma.app.create({
    data: { id: otherAppId, name: "Device Other App", package_name: `test.device.other.${suffix}` },
  });

  app = createApp({ prisma, redis: createFakeRedis() });
});

afterAll(async () => {
  await prisma.deviceProfile.deleteMany({ where: { app_id: { in: [appId, otherAppId] } } });
  await prisma.app.deleteMany({ where: { id: { in: [appId, otherAppId] } } });
  await disconnectPrisma();
});

function postDevice(body) {
  return request(app).post("/api/auth/device").send(body);
}

describe("POST /api/auth/device", () => {
  it("creates a new device profile with a day-1 streak", async () => {
    const res = await postDevice({ device_id: D.create, app_id: appId, fcm_token: "tok-1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: SYNC_MESSAGE });

    const row = await prisma.deviceProfile.findUnique({ where: { device_id: D.create } });
    expect(row.app_id).toBe(appId);
    expect(row.fcm_token).toBe("tok-1");
    expect(row.streak_count).toBe(1);
    expect(utcDay(row.last_active_date)).toBe(utcDay(now));
    expect(utcDay(row.last_streak_date)).toBe(utcDay(now));
  });

  it("performs zero writes when the token is unchanged on the same day", async () => {
    const before = await prisma.deviceProfile.findUnique({ where: { device_id: D.create } });
    await postDevice({ device_id: D.create, app_id: appId, fcm_token: "tok-1" });
    const after = await prisma.deviceProfile.findUnique({ where: { device_id: D.create } });

    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
  });

  it("updates only the FCM token when it changes mid-day", async () => {
    const before = await prisma.deviceProfile.findUnique({ where: { device_id: D.create } });
    await postDevice({ device_id: D.create, app_id: appId, fcm_token: "tok-2" });
    const after = await prisma.deviceProfile.findUnique({ where: { device_id: D.create } });

    expect(after.fcm_token).toBe("tok-2");
    expect(after.last_active_date.getTime()).toBe(before.last_active_date.getTime());
    expect(after.streak_count).toBe(1);
  });

  it("leaves the token untouched when fcm_token is omitted", async () => {
    await postDevice({ device_id: D.create, app_id: appId });
    const row = await prisma.deviceProfile.findUnique({ where: { device_id: D.create } });
    expect(row.fcm_token).toBe("tok-2");
  });

  it("increments the streak on a consecutive day and resets after a gap", async () => {
    // Seed a device whose last active/streak day was yesterday with a 3-day run.
    await prisma.deviceProfile.create({
      data: {
        device_id: D.newday,
        app_id: appId,
        last_active_date: yesterday,
        streak_count: 3,
        last_streak_date: yesterday,
      },
    });
    await postDevice({ device_id: D.newday, app_id: appId });
    const continued = await prisma.deviceProfile.findUnique({ where: { device_id: D.newday } });
    expect(continued.streak_count).toBe(4);
    expect(utcDay(continued.last_streak_date)).toBe(utcDay(now));

    // A gap of >1 day resets the streak to 1.
    await prisma.deviceProfile.create({
      data: {
        device_id: D.brk,
        app_id: appId,
        last_active_date: yesterday,
        streak_count: 5,
        last_streak_date: threeDaysAgo,
      },
    });
    await postDevice({ device_id: D.brk, app_id: appId });
    const reset = await prisma.deviceProfile.findUnique({ where: { device_id: D.brk } });
    expect(reset.streak_count).toBe(1);
  });

  it("silently rejects an unknown tenant without writing", async () => {
    const res = await postDevice({ device_id: D.unknown, app_id: randomUUID(), fcm_token: "x" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: SYNC_MESSAGE });

    const row = await prisma.deviceProfile.findUnique({ where: { device_id: D.unknown } });
    expect(row).toBeNull();
  });

  it("validates the body", async () => {
    expect((await postDevice({ app_id: appId })).status).toBe(400);
    expect((await postDevice({ device_id: "", app_id: appId })).status).toBe(400);
    expect((await postDevice({ device_id: "x".repeat(129), app_id: appId })).status).toBe(400);
    expect((await postDevice({ device_id: "d", app_id: "nope" })).status).toBe(400);

    const bad = await postDevice({ device_id: "d", app_id: "nope" });
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/auth/device", () => {
  it("returns the streak state for the owning tenant", async () => {
    await postDevice({ device_id: D.get, app_id: appId });
    const res = await request(app).get(`/api/auth/device?device_id=${D.get}&app_id=${appId}`);

    expect(res.status).toBe(200);
    expect(res.body.data.streak_count).toBe(1);
    expect(res.body.data.last_active_date).toBeTruthy();
  });

  it("404s for an unknown device or the wrong tenant", async () => {
    const unknown = await request(app).get(`/api/auth/device?device_id=nope&app_id=${appId}`);
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("NOT_FOUND");

    const foreign = await request(app).get(
      `/api/auth/device?device_id=${D.get}&app_id=${otherAppId}`,
    );
    expect(foreign.status).toBe(404);
  });

  it("validates the query", async () => {
    expect((await request(app).get(`/api/auth/device?app_id=${appId}`)).status).toBe(400);
    expect((await request(app).get("/api/auth/device?device_id=d")).status).toBe(400);
  });
});

describe("POST /api/auth/device — abuse control", () => {
  it("rate-limits at the per-IP budget (30/min)", async () => {
    const isolated = createApp({ prisma, redis: createFakeRedis() });
    let last;
    for (let i = 0; i < 31; i += 1) {
      last = await request(isolated)
        .post("/api/auth/device")
        .send({ device_id: `dev-rl-${suffix}`, app_id: appId });
    }

    expect(last.status).toBe(429);
    expect(last.body.error.code).toBe("RATE_LIMITED");
  });
});
