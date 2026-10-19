import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";

const fakePrisma = { $queryRaw: async () => [{ "?column?": 1 }] };
const fakeRedis = { ping: async () => "PONG", incr: async () => 1, expire: async () => 1 };

describe("app assembly", () => {
  it("returns a 404 error envelope for unknown /api routes", async () => {
    const app = createApp({ prisma: fakePrisma, redis: fakeRedis });
    const res = await request(app).get("/api/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns a 404 error envelope for unknown root routes", async () => {
    const app = createApp({ prisma: fakePrisma, redis: fakeRedis });
    const res = await request(app).get("/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
