import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  initSentry,
  captureException,
  isSentryEnabled,
  __setClientForTests,
  __resetForTests,
} from "../../src/lib/sentry.js";

/**
 * Step 25 — Sentry error tracking (context.md §8).
 *
 * These tests pin the `src/lib/sentry.js` contract without touching the real
 * `@sentry/node` SDK: every init injects a fake importer / fake client.
 */

const DSN = "https://publickey@o0.ingest.sentry.io/123456";

beforeEach(() => {
  __resetForTests();
});

describe("initSentry", () => {
  it("returns false and never imports the SDK when dsn is empty", async () => {
    const importer = vi.fn();

    await expect(initSentry({ dsn: "", importer })).resolves.toBe(false);

    expect(importer).not.toHaveBeenCalled();
    expect(isSentryEnabled()).toBe(false);
  });

  it("returns false and never imports the SDK when dsn is missing/undefined", async () => {
    const importer = vi.fn();

    await expect(initSentry({ dsn: undefined, importer })).resolves.toBe(false);

    expect(importer).not.toHaveBeenCalled();
    expect(isSentryEnabled()).toBe(false);
  });

  it("imports the SDK once and calls init with the exact config", async () => {
    const init = vi.fn();
    const importer = vi.fn(async () => ({ init }));

    const enabled = await initSentry({
      dsn: DSN,
      environment: "test",
      release: "1.2.3",
      tracesSampleRate: 0.25,
      importer,
    });

    expect(enabled).toBe(true);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith({
      dsn: DSN,
      environment: "test",
      release: "1.2.3",
      tracesSampleRate: 0.25,
    });
    expect(isSentryEnabled()).toBe(true);
  });

  it("does not re-init when called again after a successful init", async () => {
    const init = vi.fn();
    const importer = vi.fn(async () => ({ init }));

    await initSentry({ dsn: DSN, environment: "test", importer });
    const secondImporter = vi.fn(async () => ({ init: vi.fn() }));
    const enabled = await initSentry({ dsn: DSN, environment: "test", importer: secondImporter });

    expect(enabled).toBe(true);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(secondImporter).not.toHaveBeenCalled();
    expect(init).toHaveBeenCalledTimes(1);
  });
});

describe("captureException", () => {
  it("returns false and does not throw when no client is configured", () => {
    expect(isSentryEnabled()).toBe(false);

    expect(() => captureException(new Error("boom"))).not.toThrow();
    expect(captureException(new Error("boom"))).toBe(false);
  });

  it("forwards the error with only the documented tag subset and extra payload", () => {
    const client = { captureException: vi.fn(() => "event-id") };
    __setClientForTests(client);
    const err = new Error("sticker upload failed");

    const captured = captureException(err, {
      request_id: "req-1",
      app_id: "app-1",
      route: "/api/stickers",
      job_id: "job-1",
      job_name: "sticker:upload",
      queue: "sticker-processing",
      worker: "image-processing",
      device_id: "must-not-be-a-tag",
      extra: { filename: "cat.png" },
    });

    expect(captured).toBe(true);
    expect(client.captureException).toHaveBeenCalledTimes(1);
    expect(client.captureException).toHaveBeenCalledWith(err, {
      tags: {
        request_id: "req-1",
        app_id: "app-1",
        route: "/api/stickers",
        job_id: "job-1",
        job_name: "sticker:upload",
        queue: "sticker-processing",
        worker: "image-processing",
      },
      extra: { filename: "cat.png" },
    });
  });

  it("skips undefined/null tags, stringifies values, and defaults extra to {}", () => {
    const client = { captureException: vi.fn() };
    __setClientForTests(client);
    const err = new Error("boom");

    captureException(err, {
      request_id: 123,
      app_id: undefined,
      route: null,
      job_id: "job-9",
    });

    expect(client.captureException).toHaveBeenCalledWith(err, {
      tags: { request_id: "123", job_id: "job-9" },
      extra: {},
    });
  });

  it("swallows a throwing client and returns false", () => {
    const client = {
      captureException: vi.fn(() => {
        throw new Error("sentry is down");
      }),
    };
    __setClientForTests(client);

    expect(() => captureException(new Error("boom"), { request_id: "req-1" })).not.toThrow();
    expect(captureException(new Error("boom"), { request_id: "req-1" })).toBe(false);
    expect(client.captureException).toHaveBeenCalledTimes(2);
  });
});

describe("isSentryEnabled / test seams", () => {
  it("reflects client presence and is cleared by __resetForTests", () => {
    expect(isSentryEnabled()).toBe(false);

    __setClientForTests({ captureException: vi.fn() });
    expect(isSentryEnabled()).toBe(true);

    __resetForTests();
    expect(isSentryEnabled()).toBe(false);
  });
});
