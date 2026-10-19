import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";
import { signAccessToken } from "../../src/lib/tokens.js";

/**
 * In-memory Redis double supporting the rate limiter (INCR/EXPIRE), the cache
 * helpers (GET/SET) and cache eviction (SCAN/DEL).
 */
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
const USERNAME = `apps-admin-${suffix}`;

let app;
let prisma;
let token;
let appId;
let otherAppId;
let cacheAppId;

beforeAll(async () => {
  prisma = getPrisma();

  const admin = await prisma.admin.create({
    data: { username: USERNAME, password: "x".repeat(60) },
  });
  token = signAccessToken({ id: admin.id, username: USERNAME });

  appId = randomUUID();
  otherAppId = randomUUID();
  cacheAppId = randomUUID();

  await prisma.app.create({
    data: {
      id: appId,
      name: "Apps Test App",
      package_name: `test.apps.${suffix}`,
      target_version: 5,
      force_update: true,
    },
  });
  await prisma.app.create({
    data: {
      id: otherAppId,
      name: "Apps Other App",
      package_name: `test.apps.other.${suffix}`,
      target_version: 2,
      force_update: false,
    },
  });
  await prisma.app.create({
    data: { id: cacheAppId, name: "Apps Cache App", package_name: `test.apps.cache.${suffix}` },
  });

  app = createApp({ prisma, redis: createFakeRedis() });
});

afterAll(async () => {
  await prisma.app.deleteMany({ where: { id: { in: [appId, otherAppId, cacheAppId] } } });
  await prisma.auditLog.deleteMany({ where: { admin_username: USERNAME } });
  await prisma.admin.deleteMany({ where: { username: USERNAME } });
  await disconnectPrisma();
});

const auth = (req) => req.set("Authorization", `Bearer ${token}`);

describe("GET /api/apps/{app_id}/version", () => {
  it("returns the version policy and computes update_required", async () => {
    const behind = await request(app).get(`/api/apps/${appId}/version?current_version=3`);
    expect(behind.status).toBe(200);
    expect(behind.body).toEqual({
      success: true,
      app_id: appId,
      target_version: 5,
      force_update: true,
      maintenance_mode: false,
      update_required: true,
    });

    const current = await request(app).get(`/api/apps/${appId}/version?current_version=5`);
    expect(current.body.update_required).toBe(false);
  });

  it("treats a missing current_version as 0 (assume outdated)", async () => {
    const res = await request(app).get(`/api/apps/${appId}/version`);
    expect(res.status).toBe(200);
    expect(res.body.update_required).toBe(true);
  });

  it("never forces an update when force_update is false", async () => {
    const res = await request(app).get(`/api/apps/${otherAppId}/version?current_version=1`);
    expect(res.body).toMatchObject({
      target_version: 2,
      force_update: false,
      update_required: false,
    });
  });

  it("404s for an unknown tenant and validates input", async () => {
    expect((await request(app).get(`/api/apps/${randomUUID()}/version`)).status).toBe(404);
    expect((await request(app).get("/api/apps/not-a-uuid/version")).status).toBe(400);
    expect((await request(app).get(`/api/apps/${appId}/version?current_version=-1`)).status).toBe(
      400,
    );
    expect((await request(app).get(`/api/apps/${appId}/version?current_version=abc`)).status).toBe(
      400,
    );
  });
});

describe("GET /api/apps/{app_id}/ads", () => {
  it("returns the full six-unit inventory and master switch", async () => {
    const res = await request(app).get(`/api/apps/${appId}/ads`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      app_id: appId,
      ads_enabled: true,
      admob_banner: null,
      admob_interstitial: null,
      admob_rewarded: null,
      admob_rewarded_interstitial: null,
      admob_openad: null,
      admob_native: null,
    });
  });

  it("404s for an unknown tenant", async () => {
    expect((await request(app).get(`/api/apps/${randomUUID()}/ads`)).status).toBe(404);
  });
});

describe("version caching + invalidation", () => {
  it("serves from cache until an admin update evicts it", async () => {
    const first = await request(app).get(`/api/apps/${cacheAppId}/version?current_version=1`);
    expect(first.body.target_version).toBe(1);

    // Bypass the API to prove the second read is served from cache, not the DB.
    await prisma.app.update({ where: { id: cacheAppId }, data: { target_version: 7 } });
    const cached = await request(app).get(`/api/apps/${cacheAppId}/version?current_version=1`);
    expect(cached.body.target_version).toBe(1);

    const put = await auth(request(app).put(`/api/admin/apps/${cacheAppId}/version`)).send({
      target_version: 9,
      force_update: true,
    });
    expect(put.status).toBe(200);
    expect(put.body.data).toEqual({
      app_id: cacheAppId,
      target_version: 9,
      force_update: true,
      maintenance_mode: false,
    });

    const fresh = await request(app).get(`/api/apps/${cacheAppId}/version?current_version=1`);
    expect(fresh.body).toMatchObject({
      target_version: 9,
      force_update: true,
      update_required: true,
    });
  });
});

describe("PUT /api/admin/apps/{app_id}/version", () => {
  it("requires admin auth", async () => {
    const res = await request(app)
      .put(`/api/admin/apps/${appId}/version`)
      .send({ target_version: 2, force_update: false });
    expect(res.status).toBe(401);
  });

  it("validates the body and tenant existence", async () => {
    const bad = await auth(request(app).put(`/api/admin/apps/${appId}/version`)).send({
      target_version: 0,
      force_update: false,
    });
    expect(bad.status).toBe(400);

    const missing = await auth(request(app).put(`/api/admin/apps/${appId}/version`)).send({
      target_version: 2,
    });
    expect(missing.status).toBe(400);

    const unknown = await auth(request(app).put(`/api/admin/apps/${randomUUID()}/version`)).send({
      target_version: 2,
      force_update: false,
    });
    expect(unknown.status).toBe(404);
  });
});

describe("PUT /api/admin/apps/{app_id}/ads", () => {
  const validUnit = "ca-app-pub-1234567890123456/1234567890";

  it("updates the six units, evicts the cache, and clears with null", async () => {
    const first = await auth(request(app).put(`/api/admin/apps/${cacheAppId}/ads`)).send({
      ads_enabled: false,
      admob_banner: validUnit,
      admob_interstitial: validUnit,
      admob_rewarded: validUnit,
    });
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      app_id: cacheAppId,
      ads_enabled: false,
      admob_banner: validUnit,
      admob_interstitial: validUnit,
      admob_rewarded: validUnit,
    });

    const read = await request(app).get(`/api/apps/${cacheAppId}/ads`);
    expect(read.body).toMatchObject({ ads_enabled: false, admob_banner: validUnit });

    const cleared = await auth(request(app).put(`/api/admin/apps/${cacheAppId}/ads`)).send({
      admob_banner: null,
    });
    expect(cleared.body.data.admob_banner).toBeNull();
    expect(cleared.body.data.admob_interstitial).toBe(validUnit);
  });

  it("rejects malformed unit IDs and unknown tenants", async () => {
    const bad = await auth(request(app).put(`/api/admin/apps/${appId}/ads`)).send({
      admob_banner: "not-an-admob-id",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION_ERROR");

    const unknown = await auth(request(app).put(`/api/admin/apps/${randomUUID()}/ads`)).send({
      ads_enabled: true,
    });
    expect(unknown.status).toBe(404);
  });
});
