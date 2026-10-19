# Project State

> Live status board for agent handoffs. Keep this current after every step.

## Current

- **Phase:** 1 — Production hardening
- **Step:** 27 — API docs: README + OpenAPI/Swagger (DONE)
- **Branch:** main (initialized, no commits yet)

## Done

- [x] Step 1: scaffold, tooling, `/healthz`, agent setup.
- [x] Step 2: env Zod, pino, Prisma 7 schema+client (`@prisma/adapter-pg`), Redis, `/readyz`, seed, tests.
      Migration `20261015111029_init` applied; seed loaded (2 tenants, 6+2 stickers, 5 tags).
- [x] Step 3: AppError/errorEnvelope, Zod validate middleware, error handler + 404, Redis-backed
      rate-limit skeleton (global 300/min/IP on `/api`), `apiRouter` mount, `app.locals` wiring. 27 tests.
- [x] Step 4: feed `GET /api/stickers` (latest, cursor, tenant scope, hidden filter, tag search),
      `normalizeKeyword`, keyset cursor. 44 tests. Deviation: Unicode-aware normalization (§5.2).
- [x] Step 5: single `GET /api/stickers/{id}` (tenant-scoped, 404 STICKER_NOT_FOUND, 120/min
      per-route limit). 51 tests.
- [x] Step 6: admin auth — login (bcrypt+JWT 15m, opaque refresh 7d hashed in Redis, lockout),
      refresh/logout/me, `requireAdmin`. 65 tests.
- [x] Step 7: upload pipeline — Sharp 512×512 WebP (+animated ≤30 frames), Cloudinary adapter,
      BullMQ queue/worker, multer (5 MB, mime allowlist, magic bytes), `npm run worker`. 87 tests.
- [x] Step 8: admin create `POST /api/admin/stickers` (202 + job_id) + `GET /api/admin/jobs/{id}`.
      96 tests. Live HTTP flow verified end-to-end.
- [x] Step 9: admin update `PUT /api/admin/stickers/{id}` (metadata or image replace) + delete
      `DELETE` (row + asset job + cache eviction). `src/lib/cache.js` SCAN eviction. 109 tests.
- [x] Step 10: trending `sort_by=trending` — `src/lib/trending.js` gravity score (§5.1),
      score-cursor codec, ZSET snapshot read, maintenance queue + `trending.worker.js` repeatable
      recompute every 5 min. 125 tests. Live Redis recompute + HTTP feed + worker boot verified.
- [x] Step 11: download/share counters `POST /api/stickers/{id}/download|share` (optimistic
      200, 60/min device + 300/min IP, enqueues `sticker:increment-counter`; worker does
      `{ increment: 1 }` + `ZINCRBY trendingDelta`). 138 tests. Live HTTP → worker verified.
- [x] Step 12: Redis caching + invalidation — `src/lib/cache.js` (`feedCacheKey`, `CacheTtl`,
      `readThroughCache`, `singleFlight`, `get/setCachedJson`); feed (latest) 60s + single sticker
      300s read-through; worker evicts feed/single keys on upload/replace; cached DTO carries
      `app_id` so cross-tenant cache hits 404. 152 tests. Live TTL/stale/evict verified.
- [x] Step 13: device registration `POST /api/auth/device` (daily write-throttle, zero writes when
      unchanged; silent no-op for unknown tenants) + streaks (§4.15) + `GET /api/auth/device`
      (`{ streak_count, last_active_date }`); 30/min IP + 60/min device limits. New
      `src/modules/device/*` mounted at `/auth`. 164 tests. Live create→no-op→token change→GET verified.
- [x] Step 14: search — `POST /api/search` (normalize §5.2, reject empty, 30/min per device,
      insert + `ZINCRBY`) and `GET /api/search/trending` (ZSET `trending:search:{app_id}`, default 10
      / max 30). Maintenance worker rebuilt every 10 min (`recomputeSearchTrending`) + daily 03:00 UTC
      purge (`purgeSearchQueries`, 15-day retention). New `src/modules/search/*`, `src/lib/search.js`.
      175 tests. Live POST → live trending → worker rebuild + purge verified.
- [x] Step 15: favorites — `POST /api/user/favorites/batch` (tenant-scoped `$transaction`,
      `createMany skipDuplicates` / `deleteMany`, idempotent, drops hidden + cross-tenant ids, ≤200,
      60/min per device) and `GET /api/user/favorites` (keyset cursor, hidden excluded, sticker DTOs).
      New `src/modules/favorites/*` mounted at `/user/favorites`. 186 tests. Live add/replay/list/
      remove/list/404 verified.
- [x] Step 16: apps — public `GET /api/apps/{app_id}/version` (60s cached, `update_required`
      computed) + `GET /api/apps/{app_id}/ads` (60s cached, full six-unit AdMob inventory); admin
      `PUT /api/admin/apps/{app_id}/version` + `/ads` (JWT, unit-ID format validated, cache evicted).
      New `src/modules/apps/*` + `src/modules/admin/admin.apps.*`. 197 tests. Live login → cached
      reads → admin PUT evict+refresh → 400/401 verified.
- [x] Step 17: FCM campaign dispatcher — `firebase-admin` dep; `src/lib/fcm.js` (real/dry-run/
      unconfigured sender, lazy SDK init), `src/queues/notification.queue.js` +
      `src/workers/notification.worker.js` (atomic per-device daily claim via `NotificationLog`,
      batches of 500, release-on-transient-failure, dead-token cleanup), admin
      `POST /api/admin/notifications/broadcast` (ALL|INACTIVE, 202 + campaign_id +
      targeted_devices_count) + `GET /api/admin/notifications/{campaign_id}`. `FCM_DRY_RUN` env.
      213 tests. Live (dry-run) broadcast → worker send/cap → status verified.
- [x] Step 18: content moderation — public `POST /api/stickers/{id}/report` (idempotent upsert on
      `(device_id, image_id)`, generic 200, 10/min per device, hidden/unknown 404, tenant derived
      from sticker); admin queue `GET /api/admin/reports` (status filter, keyset cursor, tenant
      isolation, image summary); triage `POST /api/admin/reports/{id}/dismiss|resolve`; soft-delete
      pair `POST /api/admin/stickers/{id}/hide|unhide` (evicts feed/single/trending caches, instant
      removal from all public surfaces). New `src/modules/admin/admin.reports.*` mounted at
      `/admin/reports`. 225 tests. Live report→queue→dismiss→hide(404)→unhide(200) verified.
- [x] Step 19: maintenance mode (§4.18) — public `/api/*` gate `src/middleware/maintenance.js`
      (503 `MAINTENANCE_MODE` envelope) mounted before routers; tenant resolved from
      query/body/`/apps/{id}` path (sticker-id fallback only for report); exemptions
      `GET /api/apps/{app_id}/version` + `POST /api/auth/device`, admin routes never gated. Flag
      cached 60s (`maintenance:{app_id}`, `src/lib/maintenance.js`); version endpoint now exposes
      `maintenance_mode`; admin toggle `PUT /api/admin/apps/{app_id}/maintenance` evicts
      version+maintenance keys. 229 tests. Live enable→503/version-true/exemptions→disable verified.
- [x] Step 20: Sticker of the Day + search autocomplete (§4.15–4.16) — `src/lib/sotd.js`
      (deterministic weighted pick, 30-day window, fallback any visible) + worker `sotd:pick`
      repeatable (cron `5 0 * * *`) pre-warming `sotd:{app_id}:{day}` (TTL 2d); public
      `GET /api/stickers/daily` (cold-cache deterministic compute + recompute if hidden); prefix
      autocomplete `search:prefix:{app_id}` lex ZSET rebuilt by `search:suggest-recompute` (10 min),
      `GET /api/search/suggest` (`ZRANGEBYLEX LIMIT 0 8`, 60/min per IP). 246 tests. Live daily
      stable + search→suggest + worker boot verified.
- [x] Step 21: bulk admin upload (§4.17) — dependency-free ZIP reader `src/lib/zip.js` (stored +
      deflate, zip-slip hardened, 200-entry/5 MB-per-entry/100 MB-total caps); `src/queues/bulk.queue.js`
      builds a BullMQ flow (parent `sticker:bulk` + one `sticker:upload` child per image,
      `ignoreDependencyOnFailure`); `POST /api/admin/stickers/bulk` (JWT, 50 MB zip, shared metadata,
      image magic-byte check per entry, unknown tenant 404) → `202 { job_id, total }`; worker
      `summarizeBulkJob` joins child results/failures by filename for `GET /api/admin/jobs/{id}`.
      264 tests. Live 2-image zip → worker → completed 2/failed 0 with filenames verified.
- [x] Step 22: event-driven `SEARCH_MATCH` push — `src/lib/notification.js` constants (48h window,
      log type); `NotificationJob.SEARCH_MATCH`; `dispatchSearchMatch` (tenant-scoped visible image →
      normalized tags → 48h `SearchQuery` window → device filters + `last_active_date < search time`
      → per-device keyword by trending ZSET score then recency → 500-batches → atomic 1/day/device
      claim via `NotificationLog` → dead-token cleanup); upload trigger in `sticker.worker.js`
      (`jobId: search-match-<id>`, best effort, never fails the upload); `src/worker.js` injects the
      shared notification queue into both workers. 287 tests. Live worker + full upload→push chain
      verified (dry-run).
- [x] Step 23: admin audit log (§7.8) — append-only `AuditLog` model + migration
      `20261019092843_add_audit_log` (no FK to `Admin`, 4 indexes); `src/lib/audit.js`
      (`AuditAction`, `AuditTarget`, best-effort `recordAudit` that never fails the mutation);
      `recordAudit` wired into all 13 admin mutation controllers; read endpoint
      `GET /api/admin/audit` (JWT, newest-first keyset cursor, `app_id`/`action`/`admin_id` filters,
      `limit` ≤100 default 20, DTO incl. `metadata`); router is GET-only so PUT/DELETE → 404. Also
      added `auditLog` cleanup to the other admin-mutation integration tests (audit has no FK
      cascade). 314 tests. Live verified: hide/unhide + no-op version PUT → filtered audit reads;
      append-only 404/401 confirmed.
- [x] Step 24: Prometheus metrics (§8) — `prom-client@15.1.3` (approved); `src/lib/metrics.js`
      registry with `http_requests_total` + `http_request_duration_seconds` (`metricsMiddleware`,
      route-pattern labels, `req.baseUrl` rebuild for Express 5), async scrape-time
      `bullmq_queue_jobs`/`bullmq_queue_oldest_job_age_seconds` (`registerQueue`,
      `queueProviderFrom`) and `app_dependency_up` (`registerDependency`); `GET /metrics` in
      `src/app.js` outside `/api` (never rate-limited/maintenance-gated); `src/server.js` registers
      sticker/notification/maintenance queues + DB/Redis probes. 327 tests. Live scrape verified.
- [x] Step 25: Sentry error tracking + ops docs (§8) — `@sentry/node@11.8.0`; env
      `SENTRY_DSN|ENVIRONMENT|RELEASE|TRACES_SAMPLE_RATE` (empty DSN = no-op);
      `src/lib/sentry.js` (`initSentry` lazy import, never-throwing `captureException` with fixed
      tag subset, `isSentryEnabled`, test seams); `errorHandler` reports only server-side failures
      (500 / `AppError >= 500`, not 4xx); `server.js` + `worker.js` init at boot and capture
      worker `failed`/`error` with job/queue context; `docs/observability.md` (signals, alert
      thresholds + PromQL, backups policy); `.env.example` updated. 344 tests. Live boot verified
      (`sentryEnabled:false`).
- [x] Step 26: ops — `git init` (branch `main`, **no commit yet**); `.github/workflows/ci.yml`
      (Postgres+Redis services → generate → `migrate deploy` → lint → test); multi-stage `Dockerfile`
      (build generates Prisma client + prunes dev deps; runtime `node:22-bookworm-slim` + openssl,
      non-root, port 8080, API/worker share the image) + `.dockerignore`; `docker-compose.yml`
      `api`/`worker` services behind the `app` profile; `package.json` `db:migrate:deploy`. 344
      tests. Docker build + CI not runnable in the sandbox (no Docker CLI / GitHub runner); YAML
      validated.
- [x] Step 27: API docs — `openapi.yaml` (OpenAPI 3.0.3, all 38 endpoints, reusable schemas/
      params/responses); `src/lib/openapi.js` (`getOpenApiSpec` memoized read, `getSwaggerHtml`
      CDN Swagger UI); `GET /openapi.yaml` + `GET /docs` served outside `/api` in `src/app.js`
      (available during maintenance); `Dockerfile` copies `openapi.yaml`; `README.md` (setup,
      scripts, env, endpoint map, deployment); `.env.example` `PORT=3000`→`8080`. 347 tests. Live
      `/openapi.yaml` 200 yaml + `/docs` 200 html verified.

## Notes

- Infra runs via host Docker (`docker compose up -d`); sandbox reaches it on localhost.
- Prisma stable in this registry is **7.10.0** (`latest` is `8.0.0-rc`). See CHANGELOG.
- Trending ZSET is worker-managed: an empty feed is correct until `trending:recompute` first runs
  (worker boot schedules it immediately, then every 5 min). Counter increments keep it fresh via
  `ZINCRBY` between recomputes.
- Search trending ZSET `trending:search:{app_id}` is likewise worker-rebuilt every 10 min; POST
  search keeps it fresh via `ZINCRBY`. BullMQ repeatable cron (`0 3 * * *`) fired once at worker boot
  in this environment (idempotent; deleted 0).
- `cache.js` read helpers no-op on clients without GET/SET (keeps minimal test doubles working);
  `evictKeys` no-ops without SCAN.
- Device endpoint decision: unknown `app_id` → 200 success no-op (context.md §4.1 "silently reject").
- Favorites: `processed_count` = rows actually inserted/removed (idempotent replay → 0); ADD silently
  drops hidden and cross-tenant sticker ids (tenant isolation, §2.6/§4.5).
- Apps: public ads/version cached 60s in Redis (`ads:{app_id}`, `version:{app_id}`) via
  `readThroughCache`; admin PUTs update then `evictKeys`. `update_required` is derived per request
  from the cached config. The version payload includes `maintenance_mode`, and the maintenance
  guard caches the flag separately (`maintenance:{app_id}`, 60s); the admin toggle evicts both.
- Notifications: sandbox runs with `FCM_DRY_RUN=true` (no real Firebase creds). The 1/day/device cap
  is enforced by an atomic claim (insert log rows with client-generated ids + `skipDuplicates` on the
  `(device_id, day)` unique key, then re-select by id) — safe across parallel campaigns/workers;
  transient failures release the claim so BullMQ retries re-send.
- Moderation: reports carry the tenant of the reported sticker; the public report body has no
  `app_id` (spec §4.14), so a device can only report stickers it can already see (ids are per-tenant).
  Repeat reports bump `created_at`/`reason` (one row per device+sticker). Hide/unhide is the normal
  moderation action (§4.14) and evicts feed/single/trending caches; hard delete stays for confirmed
  removals.
- SOTD/autocomplete (Step 20): `sotd:{app_id}:{YYYY-MM-DD}` is pre-picked by the worker at 00:05 UTC
  but the endpoint computes the same deterministic pick on a cold cache, so results are stable
  before the worker's first run; a hidden/removed pick is recomputed. Autocomplete stores **full
  keywords** (not bare prefixes) in `search:prefix:{app_id}` so `ZRANGEBYLEX` returns renderable
  suggestions; the query has no `device_id`, so §4.16's 60/min is enforced **per IP**.
- `SEARCH_MATCH` (Step 22): audience = devices whose matching search is within 48h **and** newer
  than `last_active_date` (they searched, then did not return). Keyword preference per device:
  highest `ZSCORE trending:search:{app_id}`, ties → most recent, none trending → most recent. Uses the
  same `NotificationLog` `(device_id, day)` claim as broadcasts, so the global 1/day/device cap holds
  across notification types. The upload trigger is best effort — a queue error never fails the
  sticker upload. Log rows carry `image_id`/`keyword` for auditing.
- Bulk upload (Step 21): implemented without a zip dependency (none is on the allowlist) using
  `zlib.inflateRawSync` + a small central-directory parser. ZIP entry size/count limits are checked
  before decompression; every image entry's magic bytes are verified on the request path, so bad
  archives are rejected with 400/415 and nothing is enqueued. The parent job only aggregates child
  results (it does no image work), and child failures are ignored by the flow so partial success is
  reported per file.
- Audit log (Step 23): append-only `AuditLog` has **no FK** to `Admin`/`App`, so test-created rows
  must be cleaned explicitly (admin-mutation integration tests delete by their run-unique
  `admin_username`; `tests/integration/audit.test.js` additionally scopes by `app_id`). `recordAudit`
  is awaited before the response (deterministic in tests) but swallows+logs failures so it can never
  fail an already-succeeded mutation. Neither `metadata` nor an absent actor leaks: `admin_id` /
  `admin_username` / `target_id` / `app_id` / `metadata` are nullable.
- Metrics (Step 24): `prom-client` registry is a per-process singleton (`src/lib/metrics.js`).
  `/metrics` is unauthenticated like `/healthz` — restrict it to the internal scrape network at
  deploy time. Route labels use the matched pattern; Express 5 clears `req.baseUrl` before `finish`,
  so `metrics.js` rebuilds it from `req.originalUrl`. Queue/dependency gauges are **scrape-time**
  (async `collect`, no timers). Worker processes still emit no metrics (no HTTP server) — pushgateway
  deferred.
- Tests: the full suite has twice shown a transient failure in `search.test.js` "rate-limits at
  30/min per device" under parallel load; it passes in isolation and on re-run (timing flake, not a
  regression).

## Todo

- [x] All MVP items complete (Steps 1–22).
- [x] Step 23: admin audit log (§7.8).
- [x] Step 24: Prometheus metrics (§8) — `http_requests_total` + latency histogram, BullMQ queue
      depth/age, dependency-up gauge, `GET /metrics`.
- [x] Step 25: Sentry error tracking + alerting/backups docs (§8).
- [ ] §8 Observability (remaining): worker-process metrics via pushgateway (optional).
- [x] Step 26: ops — git repo, CI, Dockerfile. (Initial commit pending explicit request;
      deployment config/environments still to be defined per target platform.)
- [x] Step 27: API docs — `openapi.yaml`, `/openapi.yaml` + `/docs` (Swagger UI), `README.md`.
      (Initial commit still pending; Cloudinary/FCM/Sentry real credentials not yet configured.)

## Key decisions

- Global 1/day notification cap (Phase 3); keep manual `ALL` broadcast; `SEARCH_MATCH` event-driven;
  keep streak tracking (drop only the push); keyword selection prefers trending then most recent.
- Step 3 applies the FULL corrected schema in one initial migration.
- TDD per step: tests first (`tdd-test` agent), then implementation.
- Sandbox has no system Node; install at `~/.local/node` (v24 LTS).
- Observability deps: `prom-client` (Step 24, user-approved) and `@sentry/node` (Step 25, allowed
  by context.md §10.3). Sentry is a no-op unless `SENTRY_DSN` is set.

## Blockers / notes

- Dev server must use `PORT=8080` (`http://127.0.0.1:8080`); port 3000 is a black hole in this
  sandbox. See `AGENTS.md` / `CHANGELOG.md`.
- npm audit: 4 high severities in Prisma's dev-only transitive deps (mysql2/deepmerge-ts); not on
  the runtime path (Postgres). Fix requires a breaking downgrade — deferred.
