import { describe, it, expect } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  encodeScoreCursor,
  decodeScoreCursor,
} from "../../src/lib/cursor.js";
import { AppError } from "../../src/lib/errors.js";

describe("cursor", () => {
  it("round-trips createdAt and id", () => {
    const createdAt = new Date("2026-01-01T00:00:00.000Z");
    const token = encodeCursor({ createdAt, id: "abc-123" });
    const decoded = decodeCursor(token);

    expect(decoded.id).toBe("abc-123");
    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
  });

  it("produces a URL-safe token", () => {
    const token = encodeCursor({ createdAt: new Date(), id: "id" });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("throws a validation AppError on malformed input", () => {
    expect(() => decodeCursor("!!!!")).toThrow(AppError);
    expect(() => decodeCursor(Buffer.from("{}").toString("base64url"))).toThrow(AppError);
  });
});

describe("score cursor", () => {
  it("round-trips score and id", () => {
    const token = encodeScoreCursor({ score: 42.5, id: "abc" });
    expect(decodeScoreCursor(token)).toEqual({ score: 42.5, id: "abc" });
  });

  it("throws on malformed input", () => {
    expect(() => decodeScoreCursor("!!!!")).toThrow(AppError);
    expect(() =>
      decodeScoreCursor(Buffer.from(JSON.stringify({ id: "a" })).toString("base64url")),
    ).toThrow(AppError);
  });
});
