import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";

const upPrisma = { $queryRaw: async () => [{ "?column?": 1 }] };
const downPrisma = {
  $queryRaw: async () => {
    throw new Error("database down");
  },
};
const upRedis = { ping: async () => "PONG" };
const downRedis = {
  ping: async () => {
    throw new Error("redis down");
  },
};

describe("GET /readyz", () => {
  it("returns 200 when database and redis are up", async () => {
    const app = createApp({ prisma: upPrisma, redis: upRedis });
    const res = await request(app).get("/readyz");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", checks: { database: "up", redis: "up" } });
  });

  it("returns 503 with the error envelope when the database is down", async () => {
    const app = createApp({ prisma: downPrisma, redis: upRedis });
    const res = await request(app).get("/readyz");

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("NOT_READY");
    expect(res.body.error.details).toEqual({ database: "down", redis: "up" });
  });

  it("returns 503 when redis is down", async () => {
    const app = createApp({ prisma: upPrisma, redis: downRedis });
    const res = await request(app).get("/readyz");

    expect(res.status).toBe(503);
    expect(res.body.error.details).toEqual({ database: "up", redis: "down" });
  });
});
