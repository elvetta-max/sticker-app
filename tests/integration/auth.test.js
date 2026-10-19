import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import request from "supertest";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { getPrisma, disconnectPrisma } from "../../src/config/prisma.js";

const USERNAME = `admin_${randomUUID().slice(0, 8)}`;
const PASSWORD = "correct-horse-battery";

function createFakeRedis() {
  const store = new Map();
  return {
    async ping() {
      return "PONG";
    },
    async incr(key) {
      const next = (Number(store.get(key)) || 0) + 1;
      store.set(key, next);
      return next;
    },
    async expire() {
      return 1;
    },
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, String(value));
      return "OK";
    },
    async del(key) {
      return store.delete(key) ? 1 : 0;
    },
  };
}

let prisma;
let app;
let adminId;

beforeAll(async () => {
  prisma = getPrisma();
  const admin = await prisma.admin.create({
    data: { username: USERNAME, password: await bcrypt.hash(PASSWORD, 4) },
  });
  adminId = admin.id;
});

beforeEach(() => {
  app = createApp({ prisma, redis: createFakeRedis() });
});

afterAll(async () => {
  await prisma.admin.deleteMany({ where: { username: USERNAME } });
  await disconnectPrisma();
});

describe("POST /api/admin/login", () => {
  it("rejects malformed bodies", async () => {
    const res = await request(app).post("/api/admin/login").send({ username: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns an access token and an httpOnly refresh cookie", async () => {
    const res = await request(app)
      .post("/api/admin/login")
      .send({ username: USERNAME, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.access_token).toBeTruthy();
    expect(res.body.data.admin).toEqual({ id: adminId, username: USERNAME });
    expect(res.body.data.refresh_token).toBeUndefined();

    const cookie = res.headers["set-cookie"].find((c) => c.startsWith("refresh_token="));
    expect(cookie).toContain("HttpOnly");
  });

  it("returns 401 for a wrong password", async () => {
    const res = await request(app)
      .post("/api/admin/login")
      .send({ username: USERNAME, password: "nope" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("returns 401 for an unknown user", async () => {
    const res = await request(app)
      .post("/api/admin/login")
      .send({ username: "ghost", password: PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("locks the account after 5 failed attempts", async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post("/api/admin/login")
        .send({ username: USERNAME, password: "wrong" });
      expect(res.status).toBe(401);
    }

    const locked = await request(app)
      .post("/api/admin/login")
      .send({ username: USERNAME, password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe("ACCOUNT_LOCKED");
  });
});

describe("GET /api/admin/me (requireAdmin)", () => {
  it("rejects requests without a bearer token", async () => {
    const res = await request(app).get("/api/admin/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects an invalid bearer token", async () => {
    const res = await request(app).get("/api/admin/me").set("Authorization", "Bearer not.a.jwt");
    expect(res.status).toBe(401);
  });

  it("returns the authenticated admin", async () => {
    const login = await request(app)
      .post("/api/admin/login")
      .send({ username: USERNAME, password: PASSWORD });
    const token = login.body.data.access_token;

    const res = await request(app).get("/api/admin/me").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ id: adminId, username: USERNAME });
  });
});

describe("refresh + logout", () => {
  it("rotates the refresh cookie", async () => {
    const agent = request.agent(app);
    await agent.post("/api/admin/login").send({ username: USERNAME, password: PASSWORD });

    const res = await agent.post("/api/admin/refresh");
    expect(res.status).toBe(200);
    expect(res.body.data.access_token).toBeTruthy();
    expect(res.headers["set-cookie"].some((c) => c.startsWith("refresh_token="))).toBe(true);
  });

  it("rejects refresh without a cookie", async () => {
    const res = await request(app).post("/api/admin/refresh");
    expect(res.status).toBe(401);
  });

  it("invalidates the refresh token on logout", async () => {
    const agent = request.agent(app);
    const login = await agent
      .post("/api/admin/login")
      .send({ username: USERNAME, password: PASSWORD });
    const oldCookie = login.headers["set-cookie"]
      .find((c) => c.startsWith("refresh_token="))
      .split(";")[0];

    const out = await agent.post("/api/admin/logout");
    expect(out.status).toBe(200);

    const res = await request(app).post("/api/admin/refresh").set("Cookie", oldCookie);
    expect(res.status).toBe(401);
  });
});
