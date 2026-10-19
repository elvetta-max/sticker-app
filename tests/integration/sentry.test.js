import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../../src/app.js";
import { __setClientForTests, __resetForTests } from "../../src/lib/sentry.js";

/**
 * Step 25 — end-to-end error reporting through the real app stack.
 *
 * A fake Prisma double makes a public handler throw so the request reaches the
 * real `errorHandler`; a fake Sentry client proves the error is captured with
 * route context while the HTTP envelope stays unchanged.
 */

/** In-memory Redis double: rate limiter (INCR/EXPIRE) + cache (GET/SET/SCAN/DEL) + ping. */
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

/** Prisma double whose feed query throws (simulates a DB failure on the request path). */
function createThrowingPrisma(appId) {
  return {
    app: {
      findUnique: async () => ({ id: appId, maintenance_mode: false }),
    },
    image: {
      findMany: async () => {
        throw new Error("db connection lost");
      },
      findFirst: async () => null,
      findUnique: async () => null,
    },
  };
}

/** Prisma double that answers normally so a genuine 404 is produced. */
function createNotFoundPrisma(appId) {
  return {
    app: {
      findUnique: async () => ({ id: appId, maintenance_mode: false }),
    },
    image: {
      findMany: async () => [],
      findFirst: async () => null,
      findUnique: async () => null,
    },
  };
}

let client;

beforeEach(() => {
  __resetForTests();
  client = { captureException: vi.fn(() => "event-id") };
  __setClientForTests(client);
});

afterEach(() => {
  __resetForTests();
});

describe("Sentry integration through the Express error handler", () => {
  it("captures an unexpected 500 with route context and returns the standard envelope", async () => {
    const appId = randomUUID();
    const app = createApp({ prisma: createThrowingPrisma(appId), redis: createFakeRedis() });

    const res = await request(app).get(`/api/stickers?app_id=${appId}`);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      success: false,
      error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." },
    });

    expect(client.captureException).toHaveBeenCalledTimes(1);
    const [capturedError, captureContext] = client.captureException.mock.calls[0];
    expect(capturedError).toBeInstanceOf(Error);
    expect(capturedError.message).toBe("db connection lost");
    expect(captureContext.extra).toEqual({});
    expect(captureContext.tags.route).toBe(`/api/stickers?app_id=${appId}`);
    expect(typeof captureContext.tags.request_id).toBe("string");
    expect(captureContext.tags.request_id.length).toBeGreaterThan(0);
  });

  it("does not capture a normal 404", async () => {
    const appId = randomUUID();
    const stickerId = randomUUID();
    const app = createApp({ prisma: createNotFoundPrisma(appId), redis: createFakeRedis() });

    const res = await request(app).get(`/api/stickers/${stickerId}?app_id=${appId}`);

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("STICKER_NOT_FOUND");
    expect(client.captureException).not.toHaveBeenCalled();
  });
});
