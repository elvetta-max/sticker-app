import { describe, it, expect } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app.js";

/** Minimal doubles — /docs and /openapi.yaml never touch Prisma/Redis. */
function buildApp({ maintenance = false } = {}) {
  return createApp({
    prisma: { app: { findUnique: async () => ({ maintenance_mode: maintenance }) } },
    redis: { ping: async () => "PONG" },
  });
}

describe("GET /openapi.yaml", () => {
  it("serves the OpenAPI document", async () => {
    const res = await request(buildApp()).get("/openapi.yaml");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/yaml/);
    expect(res.text).toContain("openapi: 3.0.3");
  });
});

describe("GET /docs", () => {
  it("serves the Swagger UI page pointing at the spec", async () => {
    const res = await request(buildApp()).get("/docs");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("/openapi.yaml");
    expect(res.text.toLowerCase()).toContain("swagger");
  });
});

describe("API docs availability", () => {
  it("stays reachable outside /api during tenant maintenance", async () => {
    const app = buildApp({ maintenance: true });

    await request(app).get("/docs").expect(200);
    await request(app).get("/openapi.yaml").expect(200);
  });
});
