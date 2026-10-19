import { describe, it, expect } from "vitest";
import { AppError, ErrorCodes, errorEnvelope } from "../../src/lib/errors.js";

describe("AppError", () => {
  it("defaults to a 400 status and carries code/message", () => {
    const err = new AppError("SOME_CODE", "boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(400);
    expect(err.code).toBe("SOME_CODE");
    expect(err.message).toBe("boom");
  });

  it("exposes static factories with the right statuses", () => {
    expect(AppError.notFound().status).toBe(404);
    expect(AppError.validation().status).toBe(400);
    expect(AppError.unauthorized().code).toBe(ErrorCodes.UNAUTHORIZED);
    expect(AppError.forbidden().status).toBe(403);
  });
});

describe("errorEnvelope", () => {
  it("omits details when not provided", () => {
    expect(errorEnvelope("X", "msg")).toEqual({
      success: false,
      error: { code: "X", message: "msg" },
    });
  });

  it("includes details when provided", () => {
    expect(errorEnvelope("X", "msg", { a: 1 })).toEqual({
      success: false,
      error: { code: "X", message: "msg", details: { a: 1 } },
    });
  });
});
