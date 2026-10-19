# Observability & Operations

Operational reference for the Sticker API (context.md §8). Covers the signals we expose,
the alert thresholds to configure, and the backup policy.

## Signals

| Signal               | Where                      | Notes                                                                                                                 |
| -------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Structured JSON logs | stdout (pino, `pino-http`) | `request_id`, `app_id`, latency, route on every request. `/healthz`, `/readyz`, `/metrics` excluded from access logs. |
| Liveness             | `GET /healthz`             | Process is up; no dependency checks.                                                                                  |
| Readiness            | `GET /readyz`              | Postgres (`SELECT 1`) + Redis (`PING`); 503 with a `NOT_READY` envelope when either is down.                          |
| Metrics              | `GET /metrics`             | Prometheus text. Unauthenticated — **restrict to the internal scrape network**.                                       |
| Errors               | Sentry                     | API + workers. Empty `SENTRY_DSN` disables reporting (safe no-op).                                                    |

### Metric names

- `http_requests_total{method,route,status}` — request counter; `route` is the matched
  pattern (`/api/stickers/:id`) or `unmatched`.
- `http_request_duration_seconds{method,route,status}` — latency histogram (p50/p95/p99
  via `histogram_quantile`).
- `bullmq_queue_jobs{queue,state}` — BullMQ job counts per state (scrape-time).
- `bullmq_queue_oldest_job_age_seconds{queue}` — age of the oldest waiting job.
- `app_dependency_up{dependency}` — `1`/`0` for `database` and `redis`.
- `process_*`, `nodejs_*` — default process/heap/event-loop/GC metrics.

## Alert thresholds

Configure these in the monitoring stack (Prometheus alerting rules / Grafana). Values are
starting points from context.md §8 — tune against real traffic.

| Alert              | Condition                                                                 | Severity |
| ------------------ | ------------------------------------------------------------------------- | -------- |
| Feed latency       | p95 `http_request_duration_seconds` for feed routes > **0.5 s** for 5 min | warning  |
| Error rate         | 5xx ratio of `http_requests_total` > **1%** for 5 min                     | critical |
| Queue backlog age  | `bullmq_queue_oldest_job_age_seconds` > **60 s** for 5 min                | critical |
| Queue depth        | `bullmq_queue_jobs{state="waiting"}` sustained high / growing for 10 min  | warning  |
| Dependency down    | `app_dependency_up == 0` for 1 min                                        | critical |
| Readiness flapping | `/readyz` returns 503                                                     | critical |
| FCM failures       | notification worker `failed` log rate rising (or Sentry issue)            | warning  |

Suggested PromQL:

```promql
# p95 latency, feed endpoints
histogram_quantile(0.95,
  sum by (le, route) (rate(http_request_duration_seconds_bucket{route=~"/api/stickers.*"}[5m]))
) > 0.5

# 5xx ratio
sum(rate(http_requests_total{status=~"5.."}[5m]))
  / sum(rate(http_requests_total[5m])) > 0.01

# oldest waiting job
max by (queue) (bullmq_queue_oldest_job_age_seconds) > 60
```

## Error tracking (Sentry)

- Enabled by setting `SENTRY_DSN`; `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`, and
  `SENTRY_TRACES_SAMPLE_RATE` (0–1) configure the scope.
- Only server-side failures are reported: unexpected 500s and `AppError` with `status >= 500`.
  4xx validation/not-found errors are intentionally not captured.
- Worker `failed`/`error` events are captured with `job_id`, `job_name`, `queue`, `worker` tags.
- `captureException` never throws, so reporting can never break a request or job.

## Backups

- **Postgres:** managed instance with point-in-time recovery (PITR); take a daily base backup
  plus continuous WAL. Retention: 30 days. Restore drills quarterly.
- **Cloudinary:** the source of truth for sticker assets; rely on Cloudinary's own durability
  plus a daily export of raw uploads to cold storage (kept ≥ 30 days). The DB stores
  `cloudinary_public_id`, so assets can be reconciled/restored by id.
- **Redis:** treated as ephemeral (cache, rate limits, BullMQ). No backup; BullMQ jobs should be
  safe to re-run (idempotent consumers) if Redis is lost.
- **Secrets/config:** stored in the deployment secret manager, never in the repo; `.env.example`
  documents the required keys.

## Deploy notes

- `/metrics` and `/healthz`/`/readyz` are unauthenticated by design; network-restrict them.
- Worker processes do not expose HTTP metrics yet (pushgateway is a future addition).
