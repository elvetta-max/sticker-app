import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";
import { errorHandler } from "../../src/middleware/errorHandler.js";
import { AppError, ErrorCodes } from "../../src/lib/errors.js";
import { __setClientForTests, __resetForTests } from "../../src/lib/sentry.js";

/**
 * Step 25 — the error handler must report only true server-side failures to
 * Sentry (context.md §8). Client errors stay noise-free.
 */

function createRes() {
  const res = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

function createReq(overrides = {}) {
  return {
    id: "req-abc",
    originalUrl: "/api/stickers?app_id=tenant-1",
    app_id: "tenant-1",
    log: { error: vi.fn(), debug: vi.fn() },
    ...overrides,
  };
}

let client;

beforeEach(() => {
  __resetForTests();
  client = { captureException: vi.fn(() => "event-id") };
  __setClientForTests(client);
});

describe("errorHandler -> Sentry capture", () => {
  it("captures a generic unknown error (500) with request context", () => {
    const err = new Error("database exploded");
    const req = createReq();
    const res = createRes();

    errorHandler(err, req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
    });
    expect(client.captureException).toHaveBeenCalledTimes(1);
    expect(client.captureException).toHaveBeenCalledWith(err, {
      tags: {
        request_id: "req-abc",
        route: "/api/stickers?app_id=tenant-1",
        app_id: "tenant-1",
      },
      extra: {},
    });
  });

  it("captures an AppError with status 500 (and keeps its envelope)", () => {
    const err = new AppError(ErrorCodes.INTERNAL_ERROR, "worker failed", 500);
    const req = createReq();
    const res = createRes();

    errorHandler(err, req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "worker failed" },
    });
    expect(client.captureException).toHaveBeenCalledTimes(1);
    expect(client.captureException).toHaveBeenCalledWith(err, {
      tags: {
        request_id: "req-abc",
        route: "/api/stickers?app_id=tenant-1",
        app_id: "tenant-1",
      },
      extra: {},
    });
  });

  it("does not capture a ZodError (400)", () => {
    const result = z.object({ name: z.string() }).safeParse({ name: 42 });
    const err = result.error;
    const req = createReq();
    const res = createRes();

    errorHandler(err, req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: expect.objectContaining({ code: "VALIDATION_ERROR" }),
      }),
    );
    expect(client.captureException).not.toHaveBeenCalled();
  });

  it("does not capture an AppError with status < 500", () => {
    const err = new AppError(ErrorCodes.STICKER_NOT_FOUND, "Sticker not found.", 404);
    const req = createReq();
    const res = createRes();

    errorHandler(err, req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: "STICKER_NOT_FOUND", message: "Sticker not found." },
    });
    expect(client.captureException).not.toHaveBeenCalled();
  });

  it("does not capture malformed JSON (entity.parse.failed, 400)", () => {
    const err = Object.assign(new SyntaxError("Unexpected token"), {
      type: "entity.parse.failed",
    });
    const req = createReq();
    const res = createRes();

    errorHandler(err, req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Malformed JSON body." },
    });
    expect(client.captureException).not.toHaveBeenCalled();
  });

  it("leaves the response untouched when no Sentry client is configured", () => {
    __resetForTests();
    const err = new Error("database exploded");
    const req = createReq();
    const res = createRes();

    expect(() => errorHandler(err, req, res, vi.fn())).not.toThrow();

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
    });
  });
});
