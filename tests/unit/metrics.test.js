import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import {
  registry,
  httpRequestsTotal,
  httpRequestDuration,
  metricsMiddleware,
  renderMetrics,
  registerQueue,
  registerDependency,
  __resetForTests,
} from "../../src/lib/metrics.js";

/**
 * Minimal app that exercises the real `metricsMiddleware` against a static route,
 * a dynamic route and an unmatched path (context.md §8 / Step 24 contract).
 */
function buildApp() {
  const app = express();
  app.use(metricsMiddleware);
  app.get("/healthz", (_req, res) => res.status(200).json({ status: "ok" }));
  app.get("/items/:id", (req, res) => res.status(200).json({ id: req.params.id }));
  app.use((_req, res) => res.status(404).json({ success: false }));
  return app;
}

/** Returns every serialized sample line for `name` whose labels include all fragments. */
function samples(text, name, fragments = []) {
  return text
    .split("\n")
    .filter((line) => line.startsWith(`${name}{`) && fragments.every((f) => line.includes(f)));
}

beforeEach(() => {
  __resetForTests();
});

describe("metrics module exports", () => {
  it("exposes a registry plus the documented counter and histogram", () => {
    expect(registry).toBeDefined();
    expect(registry.metrics).toBeTypeOf("function");
    expect(registry.contentType).toMatch(/^text\/plain/);

    expect(httpRequestsTotal.name).toBe("http_requests_total");
    expect(httpRequestsTotal.type).toBe("counter");
    expect(httpRequestsTotal.labelNames).toEqual(["method", "route", "status"]);

    expect(httpRequestDuration.name).toBe("http_request_duration_seconds");
    expect(httpRequestDuration.type).toBe("histogram");
    expect(httpRequestDuration.labelNames).toEqual(["method", "route", "status"]);
  });
});

describe("metricsMiddleware", () => {
  it("records the request counter and duration histogram with method, route and status", async () => {
    await request(buildApp()).get("/healthz").expect(200);

    const text = await renderMetrics();

    expect(text).toContain('http_requests_total{method="GET",route="/healthz",status="200"} 1');
    expect(text).toContain(
      'http_request_duration_seconds_count{method="GET",route="/healthz",status="200"} 1',
    );
  });

  it("labels dynamic routes with the route pattern, not the raw URL id", async () => {
    const id = randomUUID();
    await request(buildApp()).get(`/items/${id}`).expect(200);

    const text = await renderMetrics();

    expect(text).toContain('http_requests_total{method="GET",route="/items/:id",status="200"} 1');
    expect(text).not.toMatch(/route="\/items\/[0-9a-f-]{36}"/);
  });

  it("records unmatched paths under the unmatched route label", async () => {
    await request(buildApp()).get("/definitely/missing").expect(404);

    const text = await renderMetrics();

    expect(text).toContain('http_requests_total{method="GET",route="unmatched",status="404"} 1');
  });
});

describe("registerQueue", () => {
  it("renders one bullmq_queue_jobs series per state and the oldest job age", async () => {
    registerQueue("sticker", {
      getJobCounts: async () => ({
        waiting: 3,
        active: 1,
        completed: 0,
        failed: 0,
        delayed: 0,
      }),
      getOldestWaitingAgeSeconds: async () => 12.5,
    });

    const text = await renderMetrics();

    expect(text).toContain('bullmq_queue_jobs{queue="sticker",state="waiting"} 3');
    expect(text).toContain('bullmq_queue_jobs{queue="sticker",state="active"} 1');
    expect(text).toContain('bullmq_queue_jobs{queue="sticker",state="completed"} 0');
    expect(text).toContain('bullmq_queue_oldest_job_age_seconds{queue="sticker"} 12.5');
  });

  it("omits the oldest job age gauge when the provider returns null", async () => {
    registerQueue("sticker-noage", {
      getJobCounts: async () => ({ waiting: 0, active: 0 }),
      getOldestWaitingAgeSeconds: async () => null,
    });

    const text = await renderMetrics();

    expect(text).toContain('bullmq_queue_jobs{queue="sticker-noage",state="waiting"} 0');
    expect(samples(text, "bullmq_queue_oldest_job_age_seconds", ['queue="sticker-noage"'])).toEqual(
      [],
    );
  });

  it("is idempotent when the same queue name is registered twice", async () => {
    const provider = {
      getJobCounts: async () => ({ waiting: 3 }),
      getOldestWaitingAgeSeconds: async () => 1,
    };

    registerQueue("sticker-twice", provider);
    expect(() => registerQueue("sticker-twice", provider)).not.toThrow();

    const text = await renderMetrics();

    expect(
      samples(text, "bullmq_queue_jobs", ['queue="sticker-twice"', 'state="waiting"']),
    ).toHaveLength(1);
    expect(
      samples(text, "bullmq_queue_oldest_job_age_seconds", ['queue="sticker-twice"']),
    ).toHaveLength(1);
  });
});

describe("registerDependency", () => {
  it("reports 1 for a resolving probe and 0 for false/throw", async () => {
    registerDependency("database", async () => true);
    registerDependency("cache", async () => false);
    registerDependency("broken", async () => {
      throw new Error("dependency down");
    });

    const text = await renderMetrics();

    expect(text).toContain('app_dependency_up{dependency="database"} 1');
    expect(text).toContain('app_dependency_up{dependency="cache"} 0');
    expect(text).toContain('app_dependency_up{dependency="broken"} 0');
  });
});

describe("renderMetrics", () => {
  it("serializes every documented metric name", async () => {
    await request(buildApp()).get("/healthz").expect(200);
    registerQueue("serialize", { getJobCounts: async () => ({ waiting: 1 }) });
    registerDependency("serialize-db", async () => true);

    const text = await renderMetrics();

    expect(typeof text).toBe("string");
    for (const name of [
      "http_requests_total",
      "http_request_duration_seconds",
      "bullmq_queue_jobs",
      "bullmq_queue_oldest_job_age_seconds",
      "app_dependency_up",
    ]) {
      expect(text).toContain(name);
    }
  });
});
