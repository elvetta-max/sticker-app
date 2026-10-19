import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { z } from "zod";
import { validate } from "../../src/middleware/validate.js";
import { errorHandler, notFound } from "../../src/middleware/errorHandler.js";

function buildApp() {
  const app = express();
  app.use(express.json());

  app.get(
    "/things",
    validate({
      query: z.object({
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
    }),
    (req, res) => res.json({ limit: req.query.limit, type: typeof req.query.limit }),
  );

  app.post("/things", validate({ body: z.object({ name: z.string().min(1) }) }), (req, res) =>
    res.json({ name: req.body.name }),
  );

  app.get("/things/:id", validate({ params: z.object({ id: z.uuid() }) }), (req, res) =>
    res.json({ id: req.params.id }),
  );

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

describe("validate middleware", () => {
  it("coerces and defaults query values", async () => {
    const res = await request(buildApp()).get("/things");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ limit: 20, type: "number" });
  });

  it("accepts a valid query value", async () => {
    const res = await request(buildApp()).get("/things?limit=10");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(10);
  });

  it("rejects an out-of-range query with the error envelope", async () => {
    const res = await request(buildApp()).get("/things?limit=999");
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details[0].path).toBe("limit");
  });

  it("rejects a missing required body field", async () => {
    const res = await request(buildApp()).post("/things").send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details[0].path).toBe("name");
  });

  it("accepts a valid body", async () => {
    const res = await request(buildApp()).post("/things").send({ name: "ok", extra: "stripped" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: "ok" });
  });

  it("rejects a non-uuid param", async () => {
    const res = await request(buildApp()).get("/things/not-a-uuid");
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].path).toBe("id");
  });

  it("accepts a valid uuid param", async () => {
    const id = "6a6bb6c7-463e-4e48-a644-c2277a21727a";
    const res = await request(buildApp()).get(`/things/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
  });

  it("returns 404 envelope for an unmatched route", async () => {
    const res = await request(buildApp()).get("/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await request(buildApp())
      .post("/things")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
