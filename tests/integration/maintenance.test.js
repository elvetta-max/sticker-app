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
const USERNAME = `maint-admin-${suffix}`;

let app;
let prisma;
let token;
let appId;
let otherAppId;
let stickerId;

beforeAll(async () => {
  prisma = getPrisma();

  const admin = await prisma.admin.create({
    data: { username: USERNAME, password: "x".repeat(60) },
  });
  token = signAccessToken({ id: admin.id, username: USERNAME });

  appId = randomUUID();
  otherAppId = randomUUID();
  await prisma.app.create({
    data: { id: appId, name: "Maint App", package_name: `test.maint.${suffix}` },
  });
  await prisma.app.create({
    data: { id: otherAppId, name: "Maint Other", package_name: `test.maint.other.${suffix}` },
  });
  const image = await prisma.image.create({
    data: {
      app_id: appId,
      image_url: `https://example.test/${suffix}/m.webp`,
      cloudinary_public_id: `test/${suffix}/m`,
    },
  });
  stickerId = image.id;

  app = createApp({ prisma, redis: createFakeRedis() });
});

afterAll(async () => {
  await prisma.app.deleteMany({ where: { id: { in: [appId, otherAppId] } } });
  await prisma.auditLog.deleteMany({ where: { admin_username: USERNAME } });
  await prisma.admin.deleteMany({ where: { username: USERNAME } });
  await disconnectPrisma();
});

const auth = (req) => req.set("Authorization", `Bearer ${token}`);

function setMaintenance(on) {
  return auth(request(app).put(`/api/admin/apps/${appId}/maintenance`)).send({
    maintenance_mode: on,
  });
}

/** The exact 503 envelope every blocked public endpoint must return. */
const MAINTENANCE_ENVELOPE = {
  success: false,
  error: {
    code: "MAINTENANCE_MODE",
    message: "Service temporarily unavailable. Please try again soon.",
  },
};

describe("maintenance mode", () => {
  it("is off by default and reported by the version endpoint", async () => {
    const version = await request(app).get(`/api/apps/${appId}/version`);
    expect(version.status).toBe(200);
    expect(version.body.maintenance_mode).toBe(false);

    expect((await request(app).get(`/api/stickers?app_id=${appId}`)).status).toBe(200);
  });

  it("evicts the cached flag and 503s every public surface except the exemptions", async () => {
    // Warm the flag cache first (a public read caches `maintenance:false`).
    expect((await request(app).get(`/api/stickers?app_id=${appId}`)).status).toBe(200);

    const on = await setMaintenance(true);
    expect(on.status).toBe(200);
    expect(on.body.data).toEqual({ app_id: appId, maintenance_mode: true });

    // Varied public surfaces resolvable by query, body, path and sticker id.
    const blocked = [
      request(app).get(`/api/stickers?app_id=${appId}`),
      request(app).get(`/api/stickers/${stickerId}?app_id=${appId}`),
      request(app).get(`/api/apps/${appId}/ads`),
      request(app).get(`/api/user/favorites?app_id=${appId}&device_id=d1`),
      request(app).post("/api/search").send({ app_id: appId, device_id: "d1", keyword: "cats" }),
      request(app)
        .post(`/api/stickers/${stickerId}/report`)
        .send({ device_id: "d1", reason: "spam" }),
      request(app)
        .post(`/api/stickers/${stickerId}/download`)
        .send({ app_id: appId, device_id: "d1" }),
    ];
    for (const res of await Promise.all(blocked)) {
      expect(res.status).toBe(503);
      expect(res.body).toEqual(MAINTENANCE_ENVELOPE);
    }

    // Exemptions stay live: version config + device sync.
    const version = await request(app).get(`/api/apps/${appId}/version`);
    expect(version.status).toBe(200);
    expect(version.body.maintenance_mode).toBe(true);

    const device = await request(app)
      .post("/api/auth/device")
      .send({ device_id: `maint-dev-${suffix}`, fcm_token: "t", app_id: appId });
    expect(device.status).toBe(200);

    // Admin routes are never gated.
    const admin = await auth(request(app).get(`/api/admin/reports?app_id=${appId}`));
    expect(admin.status).toBe(200);

    // Another tenant is unaffected.
    expect((await request(app).get(`/api/stickers?app_id=${otherAppId}`)).status).toBe(200);

    // Turning it back off restores public traffic immediately.
    expect((await setMaintenance(false)).status).toBe(200);
    expect((await request(app).get(`/api/stickers?app_id=${appId}`)).status).toBe(200);
  });

  it("refreshes the cached version payload after a toggle", async () => {
    await setMaintenance(true);
    const on = await request(app).get(`/api/apps/${appId}/version`);
    expect(on.body).toMatchObject({ app_id: appId, maintenance_mode: true });

    await setMaintenance(false);
    const off = await request(app).get(`/api/apps/${appId}/version`);
    expect(off.body.maintenance_mode).toBe(false);
  });
});

describe("PUT /api/admin/apps/{app_id}/maintenance", () => {
  it("requires admin auth and validates the body/tenant", async () => {
    const noAuth = await request(app)
      .put(`/api/admin/apps/${appId}/maintenance`)
      .send({ maintenance_mode: true });
    expect(noAuth.status).toBe(401);

    const badBody = await auth(request(app).put(`/api/admin/apps/${appId}/maintenance`)).send({
      maintenance_mode: "yes",
    });
    expect(badBody.status).toBe(400);
    expect(badBody.body.error.code).toBe("VALIDATION_ERROR");

    const unknown = await auth(
      request(app).put(`/api/admin/apps/${randomUUID()}/maintenance`),
    ).send({ maintenance_mode: true });
    expect(unknown.status).toBe(404);
  });
});
