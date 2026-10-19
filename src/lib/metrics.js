import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from "prom-client";

/**
 * Prometheus metrics (context.md §8). One process-wide registry.
 *
 * HTTP counters/histograms are recorded by `metricsMiddleware`; BullMQ queue depth/age
 * and dependency health are exposed as scrape-time gauges via `registerQueue` /
 * `registerDependency` so the API process never blocks on a background poll.
 */
export const registry = new Registry();

// Process/event-loop metrics (memory, CPU, event-loop lag, GC). Collect-based, no timers.
collectDefaultMetrics({ register: registry });

/** Total HTTP requests handled, by method, route pattern and status. */
export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests handled.",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

/** HTTP request latency in seconds, by method, route pattern and status. */
export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request latency in seconds.",
  labelNames: ["method", "route", "status"],
  registers: [registry],
});

/** Queue name -> `{ getJobCounts, getOldestWaitingAgeSeconds? }`. */
const queueProviders = new Map();

/** Dependency name -> async boolean probe. */
const dependencyProviders = new Map();

new Gauge({
  name: "bullmq_queue_jobs",
  help: "Number of BullMQ jobs per queue and state.",
  labelNames: ["queue", "state"],
  registers: [registry],
  async collect() {
    this.reset();
    for (const [queue, provider] of queueProviders) {
      const counts = (await provider.getJobCounts()) ?? {};
      for (const [state, value] of Object.entries(counts)) {
        this.set({ queue, state }, value);
      }
    }
  },
});

new Gauge({
  name: "bullmq_queue_oldest_job_age_seconds",
  help: "Age in seconds of the oldest waiting BullMQ job per queue.",
  labelNames: ["queue"],
  registers: [registry],
  async collect() {
    this.reset();
    for (const [queue, provider] of queueProviders) {
      if (typeof provider.getOldestWaitingAgeSeconds !== "function") continue;
      const age = await provider.getOldestWaitingAgeSeconds();
      if (typeof age === "number" && Number.isFinite(age)) {
        this.set({ queue }, age);
      }
    }
  },
});

new Gauge({
  name: "app_dependency_up",
  help: "Whether a downstream dependency is reachable (1 = up, 0 = down).",
  labelNames: ["dependency"],
  registers: [registry],
  async collect() {
    this.reset();
    for (const [dependency, probe] of dependencyProviders) {
      let up;
      try {
        up = (await probe()) ? 1 : 0;
      } catch {
        up = 0;
      }
      this.set({ dependency }, up);
    }
  },
});

/**
 * Register (or replace) a BullMQ queue for scrape-time metrics. Idempotent per name.
 * @param {string} name
 * @param {{ getJobCounts: Function, getOldestWaitingAgeSeconds?: Function }} provider
 */
export function registerQueue(name, provider) {
  queueProviders.set(name, provider);
}

/**
 * Register (or replace) a dependency health probe. Idempotent per name.
 * @param {string} name
 * @param {() => Promise<boolean>} probe
 */
export function registerDependency(name, probe) {
  dependencyProviders.set(name, probe);
}

/**
 * Derive a metrics provider from a BullMQ `Queue` (age of the oldest waiting job).
 * @param {object} queue
 */
export function queueProviderFrom(queue) {
  return {
    getJobCounts: () => queue.getJobCounts(),
    getOldestWaitingAgeSeconds: async () => {
      const jobs = await queue.getWaiting(0, 1);
      const oldest = jobs?.[0];
      if (!oldest || typeof oldest.timestamp !== "number") return null;
      return Math.max(0, (Date.now() - oldest.timestamp) / 1000);
    },
  };
}

/**
 * Resolve the route pattern for a request. `req.route` is the matched route, but in
 * Express 5 `req.baseUrl` is restored to "" before the `finish` event fires, so when it
 * is gone we rebuild the mount path from the URL + relative route path.
 * @param {import("express").Request} req
 */
function routeLabel(req) {
  if (!req.route) return "unmatched";

  const path = Array.isArray(req.route.path) ? req.route.path[0] : req.route.path;

  let full;
  if (req.baseUrl) {
    full = `${req.baseUrl}${path}`;
  } else {
    const routeSegments = String(path).split("/").filter(Boolean);
    const urlSegments = req.originalUrl.split("?")[0].split("/").filter(Boolean);
    const base = urlSegments.slice(0, Math.max(0, urlSegments.length - routeSegments.length));
    const joined = [...base, ...routeSegments].join("/");
    full = joined ? `/${joined}` : "/";
  }

  return full.length > 1 ? full.replace(/\/+$/, "") : full;
}

/**
 * Express middleware: observe every completed request. Must be mounted before routes
 * so it can read the matched route pattern (`req.route`) when the response finishes.
 */
export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const labels = {
      method: req.method,
      route: routeLabel(req),
      status: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
  });

  next();
}

/** Prometheus text exposition for `GET /metrics`. */
export function renderMetrics() {
  return registry.metrics();
}

/** Test-only: clear registered providers and reset all metric values. */
export function __resetForTests() {
  queueProviders.clear();
  dependencyProviders.clear();
  registry.resetMetrics();
}
