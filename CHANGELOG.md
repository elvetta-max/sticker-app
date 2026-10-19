# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Dev environment

- Dev port moved from 3000 to **8080** (`.env` `PORT=8080`). Port 3000 is a black
  hole in this sandbox: a stale listener bound to `::0.0.0.0:3000` accepts connections
  but never replies, hanging browsers. Use `http://127.0.0.1:8080`.

### Step 1 — Repo bootstrap + tooling (2026-10-15)

- Initialized ESM Node.js project (`package.json`, Node >= 20).
- Added tooling: ESLint (flat config), Prettier, Vitest + Supertest.
- Added `GET /healthz` liveness endpoint and server bootstrap (`src/app.js`, `src/server.js`).
- Added `.env.example`, `docker-compose.yml` (Postgres 16 + Redis 7), `.gitignore`.
- Added project governance: `AGENTS.md`, `opencode.json`, `project_state.md`, `CHANGELOG.md`.
- Added opencode subagents: `tdd-test`, `foundation-dev`, `backend-dev`, `security-reviewer`.

### Step 2 — Config, data layer & infra clients (2026-10-15)

- Env validation with Zod (`src/config/env.js`), fail-fast on boot; `.env` for local dev.
- Structured logging with pino + pino-http request logging (`src/config/logger.js`).
- Data layer: full corrected Prisma schema (context.md §3) + `NotificationLog` + `AdminApp`
  - `DeviceProfile.notifications_enabled`; Prisma client singleton (`src/config/prisma.js`).
- Redis client singleton with lazy connect + fast-fail (`src/config/redis.js`).
- `GET /readyz` (DB + Redis readiness) with injectable deps for testing.
- Seed script `prisma/seed.js`: 2 tenants, tags, sample stickers (incl. hidden + premium).
- Tests: `tests/unit/env.test.js`, `tests/integration/readyz.test.js` (8 passing).
- Decisions: Prisma **7.10.0** (stable) with the required `prisma.config.ts` (TypeScript) and the
  `@prisma/adapter-pg` driver adapter. TS is confined to the Prisma config; application code stays JS.
- Note: `Admin` seeding deferred to Step 7 (needs bcrypt).

### Step 3 — Core middleware & app assembly (2026-10-15)

- `src/lib/errors.js`: `AppError`, `ErrorCodes`, `errorEnvelope` (consistent `{success:false,error:{code,message,details?}}`).
- `src/middleware/validate.js`: Zod validation for params/query/body; Express 5 `req.query` (getter-only) handled via `Object.defineProperty`.
- `src/middleware/errorHandler.js`: central handler (Zod / AppError / malformed JSON / 500) + `notFound` 404 envelope.
- `src/middleware/rateLimit.js`: Redis-backed fixed-window limiter (fail-open), global 300 req/min/IP on `/api`.
- `src/routes/index.js`: public `apiRouter` mount point; `createApp` now exposes `app.locals.prisma` / `app.locals.redis`.
- Tests: +19 (errors unit, validate, rate-limit, app assembly) → **27 passing**.

### Step 4 — Public feed `GET /api/stickers` (2026-10-15)

- `src/lib/normalize.js`: `normalizeKeyword` (§5.2). **Deviation:** uses `[^\p{L}\p{N}\s]` (Unicode-aware)
  instead of `[^a-z0-9\s]`, which would delete Arabic and defeat its own tashkeel-stripping step.
- `src/lib/cursor.js`: opaque base64url keyset cursor (`created_at` + `id`) with validation.
- `src/modules/stickers/*`: schema (Zod), service, controller, routes, DTO mapper.
- Feed: tenant-scoped (`app_id`), `is_hidden = false`, `sort_by=latest`, `search` over tags,
  cursor pagination via `take: limit + 1`, `limit` capped at 50, unknown tenant → 404.
- Tests: +17 (normalize, cursor, feed integration) → **44 passing**. `sort_by=trending` deferred to Step 10.

### Step 5 — Single sticker `GET /api/stickers/{id}` (2026-10-15)

- `getSticker` service: tenant-scoped (`app_id` query), `is_hidden = false`; hidden / cross-tenant /
  missing ids all return `404 STICKER_NOT_FOUND` (no leakage).
- Route adds `stickerIdParamsSchema` + `stickerGetQuerySchema` (required `app_id`) and a per-route
  rate limit (120/min/IP, `X-RateLimit-Limit`).
- Tests: +7 (single integration) → **51 passing**.

### Step 6 — Admin auth: login, JWT, requireAdmin (2026-10-15)

- Added deps `bcrypt` + `jsonwebtoken` (both on the approved list).
- `POST /api/admin/login` — bcrypt compare (constant-time dummy hash on unknown user), HS256
  access token (15 min), opaque refresh token (7 days) stored hashed in Redis + httpOnly cookie;
  10/min/IP limit + lockout after 5 failures (`ACCOUNT_LOCKED`).
- `POST /api/admin/refresh` (rotates cookie), `POST /api/admin/logout`, `GET /api/admin/me`.
- `requireAdmin` Bearer guard; `BCRYPT_ROUNDS` env (≥12); one-time `npm run admin:create`.
- New error codes `INVALID_CREDENTIALS`, `ACCOUNT_LOCKED`.
- Tests: +13 (tokens unit + auth integration) → **65 passing**.
- Note: `npm audit` flags 4 high severities in Prisma's dev-only transitive deps (mysql2/deepmerge-ts);
  not on our runtime path (we use Postgres); fix would require a breaking Prisma downgrade — deferred.

### Step 7 — Upload pipeline: BullMQ + Sharp + Cloudinary + multer (2026-10-15)

- Added deps `bullmq`, `sharp`, `cloudinary`, `multer` (all on the approved list).
- `src/lib/image.js`: Sharp pipeline → exact 512×512 WebP (quality 82, effort 4); multi-page
  sources become animated WebP, capped at 30 frames (`assertFrameCount`).
- `src/config/cloudinary.js`: lazily-configured signed client + adapter (`uploadSticker` under
  `tenants/{app_id}`, `destroySticker`), injectable for tests.
- `src/queues/{connection,sticker.queue}.js`: BullMQ connection options + producer (attempts 3,
  exponential backoff).
- `src/workers/sticker.worker.js`: pure `processStickerJob` (upload / replace / delete-asset) +
  `startStickerWorker` (4xx validation errors become `UnrecoverableError` to avoid wasted retries).
- `src/middleware/upload.js`: multer memory storage, 5 MB cap, mime allowlist, magic-byte
  signature verification (`sniffImageType`).
- `src/worker.js` + `npm run worker`: worker process entrypoint.
- Tests: +22 (image, upload middleware, queue options, worker integration) → **87 passing**.
  End-to-end queue→worker→DB round trip verified against real Redis (Cloudinary mocked).

### Step 8 — Admin create + job status (202, poll) (2026-10-15)

- `POST /api/admin/stickers`: `requireAdmin` → 120/min-per-admin limit → multer (5 MB, mime,
  magic bytes) → Zod body (`app_id`, `is_premium`, `is_animated`, `emojis`, `tags`) → enqueue
  `sticker:upload` → `202 { success, job_id }`.
- `GET /api/admin/jobs/{job_id}`: `requireAdmin`, returns `{ job_id, name, status, progress,
result, error }` (surfaces bulk `total/completed/failed/results` when present).
- New module `src/modules/admin/*`; `app.locals.stickerQueue` injectable (no eager Redis connect).
- Tests: +9 (create endpoint + jobs) → **96 passing**. Live flow verified over HTTP
  (202 → poll `active`→`completed` → result → sticker visible in feed).

### Step 9 — Admin update + delete (2026-10-15)

- `PUT /api/admin/stickers/{id}`: JSON or multipart; metadata-only updates run in a transaction
  (tags replaced via `set`, unspecified fields untouched); a new image enqueues `sticker:replace`
  (worker swaps the Cloudinary asset, preserving metadata not supplied).
- `DELETE /api/admin/stickers/{id}`: deletes the row (cascades favorites/reports), enqueues
  `sticker:delete-asset`, and evicts app caches.
- `src/lib/cache.js`: SCAN-based `evictKeys` + `stickerCachePatterns` (uses the §6.3 key scheme).
- `verifyImageSignatureOptional` for PUT; reusable `stickerIdParamsSchema`.
- Tests: +13 (update, delete, cache) → **109 passing**. Live HTTP create→update→replace→delete→404 verified.

### Step 10 — Trending feed + maintenance worker (2026-10-16)

- `src/lib/trending.js`: gravity score `(downloads*3 + shares) / POW(age_hours + 2, 1.5)` (§5.1),
  per-app ZSET key `trending:stickers:{app_id}`, `(score, id)` cursor helpers
  (`isAfterCursor`/`paginateScored`, reverse-lexicographic tie-break) and `parseWithScores`.
- `src/lib/cursor.js`: `encodeScoreCursor`/`decodeScoreCursor` for the stable snapshot cursor.
- `GET /api/stickers` now supports `sort_by=trending`: reads the ZSET snapshot
  (`zrevrangebyscore ... WITHSCORES`), re-fetches only page ids (tenant + `is_hidden=false` +
  optional tag search), never runs an aggregation on the request path. `sort_by` enum → `latest|trending`.
- `src/queues/maintenance.queue.js` + `src/workers/trending.worker.js`: repeatable
  `trending:recompute` job (every 5 min) rebuilding each tenant's ZSET; `recomputeTrendingForApp`
  is idempotent (del + zadd + 10 min TTL). Wired into `src/worker.js` (graceful shutdown).
- Tests: +16 (unit trending/cursor + integration trending feed w/ in-memory sorted-set double) →
  **125 passing**. Live verified: real-Redis recompute (hidden excluded), HTTP tenant-scoped
  trending feed on `:8080`, worker boot + one recompute run (`{apps:2, stickers:7}`).
- Fix: BullMQ custom `jobId` may not contain `:` (use `trending-recompute`).

### Step 11 — Download/share counters (async, ZINCRBY freshness) (2026-10-16)

- `POST /api/stickers/{id}/download` and `POST /api/stickers/{id}/share` (§4.4):
  Zod-validated `{ app_id, device_id }`, tenant + `is_hidden=false` scoped (cross-tenant,
  hidden, or missing → 404 `STICKER_NOT_FOUND`), rate-limited **60/min per device_id** and
  **300/min per IP** on top of the global limiter.
- Response is optimistic: `{ success: true, current_downloads | current_shares: stored + 1 }`.
  The write never happens on the request path — the endpoint enqueues `sticker:increment-counter`.
- `src/lib/trending.js`: `ENGAGEMENT_WEIGHTS` (downloads 3×) + `trendingDelta()` (per-unit
  score contribution), so the worker can `ZINCRBY` the trending ZSET between 5-min recomputes.
- `src/workers/sticker.worker.js`: `handleIncrementCounter` atomically increments the counter
  (`{ increment: 1 }`) and nudges the ZSET with `trendingDelta`; worker now takes `redis`.
- Tests: +13 (unit delta, integration endpoints incl. 404/400/429, worker counter) → **138 passing**.
  Live verified on `:8080` + real worker: POST → 200 optimistic → worker applied DB increment and
  raised the ZSET score; demo data reverted afterwards.

### Step 12 — Redis caching + invalidation (2026-10-16)

- `src/lib/cache.js` gains the full §6.3 toolkit: `CacheTtl`, `feedCacheKey(appId, query)`
  (`stickers:{app_id}:{sha1(query)}`), `singleStickerCacheKey`, `adsCacheKey`/`versionCacheKey`
  (for the later ads/version endpoints), `feedCachePattern`, `getCachedJson`/`setCachedJson`
  (best-effort, no-op on clients without GET/SET), `singleFlight` (in-memory stampede guard) and
  `readThroughCache`.
- Feed `GET /api/stickers` (`latest`) is now read-through cached (TTL 60s) keyed by the full query;
  trending stays ZSET-served. Single `GET /api/stickers/{id}` cached 300s; the cached DTO carries
  `app_id` and cross-tenant requests are rejected on a cache hit (no tenant leakage).
- Invalidation: worker upload/replace evict `stickers:{app_id}:*` (and `sticker:{id}` on replace);
  admin update/delete already evict via `stickerCachePatterns`.
- Tests: +14 (cache unit helpers/keys/single-flight + integration stale-serve/evict + worker
  eviction) → **152 passing**. Live verified on `:8080` + real Redis: feed key TTL ~60s, single key
  TTL ~300s, DB mutation served stale from cache, and fresh after `DEL`.
- Note: ads/version caches can't be populated until those endpoints land (later step); helpers are
  in place.

### Step 13 — Device registration, daily throttle & streaks (2026-10-17)

- New `src/modules/device/*` mounted at `/api/auth/device`:
  - `POST /api/auth/device` (§4.1): Zod `{ device_id, fcm_token?, app_id }`; create with
    `streak_count = 1` / `last_streak_date = today`; existing device gets **zero writes** when the
    day and token are unchanged, token-only update mid-day, and a full refresh on a new day.
    Unknown tenant is a **silent no-op** (200 success, nothing persisted) per §4.1.
  - `GET /api/auth/device?device_id=&app_id=` (§4.15): returns `{ streak_count, last_active_date }`,
    tenant-scoped, 404 `NOT_FOUND` otherwise.
- Streaks (§4.15) ride the daily-throttled write: `streak_count + 1` when the prior streak day was
  yesterday, else reset to 1 (`last_streak_date = today`). No extra writes.
- Abuse control: 30 req/min per IP + 60 req/min per `device_id` (validated before the limiter so the
  device key is well-formed).
- Tests: +12 (device integration incl. zero-write throttle assertion, mid-day token change, streak
  continue/reset, silent unknown tenant, validation, 404s, 30/min IP limit; rateLimit keyGenerator
  isolation) → **164 passing**. Live verified on `:8080`: create → same-day no-op → token change →
  GET streak → unknown tenant not persisted; test device cleaned up.
- Decision: §4.1 "silently reject unknown tenants" implemented as a 200 success no-op (no write, no
  tenant-existence leak).

### Step 14 — Search logging + trending search (2026-10-17)

- New `src/modules/search/*` mounted at `/api/search`:
  - `POST /api/search` (§4.6): Zod `{ device_id, app_id, keyword }`; keyword normalized (§5.2) and
    an empty result is rejected (400) without storing. Unknown tenant → 404. Validates then
    rate-limits **30/min per device**. Inserts the row directly and nudges the trending ZSET
    (`ZINCRBY`) so it stays fresh between rebuilds — the aggregation never runs on the request path.
  - `GET /api/search/trending?app_id=&limit=` (§4.6): served from the worker-maintained ZSET
    `trending:search:{app_id}`; `limit` default 10, max 30; returns `[{ keyword, count }]`,
    tenant-scoped, 404 for unknown tenant.
- `src/lib/search.js`: key + cadence constants (10-min rebuild, 20-min TTL, 7-day window,
  15-day retention, `0 3 * * *` purge cron).
- Maintenance worker (`src/workers/trending.worker.js`) gains `recomputeSearchTrending`
  (GROUP BY keyword over the last 7 days per app; clears keys for apps with no recent searches) and
  `purgeSearchQueries` (deletes rows older than 15 days). `src/queues/maintenance.queue.js` +
  `src/worker.js` schedule both repeatables; `MaintenanceJob` gains `SEARCH_TRENDING_RECOMPUTE` and
  `SEARCH_PURGE`.
- Tests: +11 (search log/normalize/empty/unknown/validation/30-min limit, trending ordering +
  limit + tenant isolation + stale-key clear + empty, purge retention) → **175 passing**.
  Live verified on `:8080` + worker: POST normalizes & persists, live `ZINCRBY` trending, worker
  rebuilt search trending (`{apps:2, keywords:2}`) and ran the purge job; smoke rows cleaned up.

### Step 15 — Bulk favorites (2026-10-17)

- New `src/modules/favorites/*` mounted at `/api/user/favorites` (context.md §4.5):
  - `POST /api/user/favorites/batch`: Zod `{ device_id, app_id, favorite_image_ids (≤200), action }`.
    Unknown tenant → 404. `ADD` filters ids to **visible stickers of the same tenant** before
    inserting (hidden/cross-tenant ids are silently dropped, never stored), then
    `createMany({ skipDuplicates: true })` inside a `$transaction`; `REMOVE` is a tenant+device-scoped
    `deleteMany`. Idempotent by design (`@@unique([device_id, image_id])`) so the Android offline
    queue can safely replay; `processed_count` is rows actually inserted/removed (0 on replay).
    Response `{ success: true, processed_count, message }`. 60/min per device_id.
  - `GET /api/user/favorites?device_id=&app_id=&cursor=&limit=`: cursor-paginated (keyset on
    `(created_at, id)`, default 20 / max 50), tenant+device scoped, excludes hidden stickers,
    returns sticker DTOs + `next_cursor` so the client can re-hydrate after reinstall.
- Tests: +11 (ADD persist + idempotent replay, in-batch dedupe, hidden/cross-tenant drop, empty
  batch, REMOVE + idempotent, unknown tenant 404, validation, 60/min limit, GET ordering/pagination/
  hidden-exclusion/isolation) → **186 passing**. Live verified on `:8080`: add(3)→replay(0)→list(3)
  →remove(1)→list(2)→unknown-tenant 404; smoke favorites cleaned up.

### Step 16 — Ads config + app version management (2026-10-17)

- New `src/modules/apps/*` public router at `/api/apps` (context.md §4.12–4.13):
  - `GET /api/apps/{app_id}/version?current_version=`: 60s Redis read-through cache
    (`version:{app_id}`); returns `{ success, app_id, target_version, force_update, update_required }`
    with `update_required = force_update && current_version < target_version` computed server-side.
    Missing `current_version` is treated as `0` (force still surfaces). Unknown tenant → 404.
  - `GET /api/apps/{app_id}/ads`: 60s Redis read-through cache (`ads:{app_id}`); returns
    `ads_enabled` + the full six-unit AdMob inventory (all nullable).
- New `src/modules/admin/admin.apps.*` admin router at `/api/admin/apps` (JWT + 120/min per admin):
  - `PUT /{app_id}/version` `{ target_version, force_update }` — validates, updates, evicts the
    version cache.
  - `PUT /{app_id}/ads` — each of the six units optional/nullable, format-checked against
    `^ca-app-pub-\d+\/[\w-]+$`; `null` clears; evicts the ads cache.
- Tests: +11 (version math + missing/force-off cases, unknown tenant 404, input validation, ads
  inventory, read-through cache served-until-evicted, admin auth + body validation, ads update +
  null-clear + bad-format + cache eviction) → **197 passing**. Live verified on `:8080`: login →
  cached reads → admin version/ads PUT evicts and refreshes → 400 bad unit / 401 no auth; demo app
  state restored.

### Step 17 — FCM campaign dispatcher (Phase 3) (2026-10-17)

- New dependency: **firebase-admin** (explicitly approved by context.md §10.3). Push is Firebase
  Admin SDK only; the SDK is imported lazily so the API/worker boot path never requires it.
- `src/lib/fcm.js`: pluggable FCM sender (`sendBatch(tokens, message) -> { responses }`), selected by
  config — real Firebase sender (lazy init, `sendEachForMulticast`), `FCM_DRY_RUN=true` dry-run
  sender (local/dev; simulates success), or a failing placeholder when unconfigured. Dead-token
  codes: `registration-token-not-registered`, `invalid-registration-token`.
- `src/queues/notification.queue.js` + `src/workers/notification.worker.js`: `notification:broadcast`
  job. The worker loads targeted devices, **atomically claims each device for the day** via
  `NotificationLog` (client-generated ids + `skipDuplicates` on the `(device_id, day)` unique key →
  global 1/day/device cap holds even across parallel workers/retries), sends in **batches of 500**,
  releases claims for transient failures (so retries re-send), and nulls dead FCM tokens.
- `src/modules/admin/admin.notifications.*` at `/api/admin/notifications` (JWT + 120/min per admin):
  - `POST /broadcast` `{ app_id, target_type: ALL|INACTIVE, title, body, data? }` — resolves the
    audience at request time (token + `notifications_enabled`; `INACTIVE` = idle ≥ 3 days), enqueues
    with `jobId = campaign_id`, returns `202 { success, campaign_id, targeted_devices_count }`.
  - `GET /{campaign_id}` — campaign status/result by id.
  - Per the locked Phase-3 design, `SEARCH_BASED` is **not** a manual target (search-driven sends are
    the event-driven `SEARCH_MATCH` in a later step) and the `STREAK_AT_RISK` push is dropped.
- Env: `FCM_DRY_RUN` (default false). `src/config/env.js`, `.env`, `.env.example` updated;
  `src/worker.js` starts the notification worker; `createApp` gains a `notificationQueue` dep.
- Tests: +16 (`src/lib/fcm` adapter selection, empty/oversized audience, batch-boundary
  [500/1], 1-day cap, dead-token clearing + FAILED status, failed-batch release, endpoint
  auth/validation/404, campaign status, real-DB dispatch) → **213 passing**. Live verified on `:8080`
  - worker (dry-run): register devices → broadcast ALL (2 targeted) → worker sent 2 & capped the
    earlier campaigns → status shows per-campaign results; smoke data cleaned up.

### Step 18 — Content moderation (2026-10-19)

- Public `POST /api/stickers/{id}/report` (context.md §4.14): body
  `{ device_id (1–128), reason: inappropriate|copyright|spam|other }`. The sticker must exist and be
  visible (hidden/unknown → 404 `STICKER_NOT_FOUND`); the report's tenant is derived from the sticker.
  **Idempotent** via `@@unique([device_id, image_id])` — a repeat report bumps the existing row's
  `created_at`/`reason` instead of duplicating. Always returns a generic `{ success: true }` (never
  leaks moderation state). Rate-limited **10/min per device_id** (`rl:report-device`), body validated
  before the limit so the key is well-formed.
- Admin moderation queue — new `src/modules/admin/admin.reports.*` at `/api/admin/reports` (JWT):
  - `GET /?app_id=&status=OPEN|REVIEWED|DISMISSED&cursor=&limit=` — tenant-scoped, newest-first,
    keyset cursor `(created_at,id)`, default 20 / max 50, status defaults to `OPEN`, includes an
    embedded image summary; unknown tenant → 404.
  - `POST /{id}/dismiss` → `DISMISSED`; `POST /{id}/resolve` → `REVIEWED`; unknown → 404 (120/min per
    admin). Triage endpoints share the `rl:admin-mutation` limit.
- Admin soft-delete pair — `POST /api/admin/stickers/{id}/hide` / `/unhide` (§4.14) in
  `admin.stickers.*`: sets `is_hidden` and **immediately evicts** the app's feed/single/trending
  caches, so the sticker vanishes from (or returns to) every public surface instantly. Hidden
  stickers are excluded from feed, single-read, search, and favorites.
- Tests: +12 (`tests/integration/moderation.test.js`: report create + tenant stamp, idempotent
  reason-bump with single row, hidden/unknown 404, param/body validation, 10/min device limit;
  queue tenant isolation + status filter + cursor pagination + auth/validation/unknown-tenant;
  dismiss/resolve + 404; hide → public 404 + feed exclusion (cache eviction proven) → unhide
  restores) → **225 passing**. Live verified on `:8080`: report (idempotent reason bump) → admin
  queue (with image) → dismiss → hide (public GET 404, feed excludes) → unhide (200 restored);
  smoke data cleaned up.

### Step 19 — Maintenance mode (2026-10-19)

- Public maintenance gate (`src/middleware/maintenance.js`, context.md §4.18): mounted on
  `/api/*` before the routers (`apiRouter.use(maintenanceGuard)`). When a tenant's
  `maintenance_mode` flag is on, every public endpoint returns
  `503 { success: false, error: { code: "MAINTENANCE_MODE", message: "Service temporarily
unavailable. Please try again soon." } }`.
  - The tenant is resolved cheaply from `app_id` in the query, body, or `/apps/{app_id}` path;
    only `POST /api/stickers/{id}/report` (whose body carries no `app_id`) falls back to a
    single sticker→app lookup. Unresolvable tenant → falls through to the routers' own 400/404.
  - Exemptions (§4.18): `GET /api/apps/{app_id}/version` and `POST /api/auth/device`. Admin
    routes are never gated (`/api/admin/*`).
- Flag is cached in Redis (`maintenance:{app_id}`, 60s TTL) via `src/lib/maintenance.js`
  (`MAINTENANCE_MESSAGE`, `readMaintenanceFlag`) — one cheap key read per public request.
- Version endpoint now exposes `maintenance_mode` (`VERSION_SELECT` + `toVersionConfig`), so the
  (exempt) client launch call carries the maintenance state.
- Admin toggle: `PUT /api/admin/apps/{app_id}/maintenance` `{ maintenance_mode: boolean }`
  (JWT + 120/min per admin) → updates and evicts **both** `version:{app_id}` and
  `maintenance:{app_id}`, so the gate flips immediately (no 60s cache lag). Unknown tenant → 404.
- Tests: +4 (`tests/integration/maintenance.test.js`: default-off + version exposure; 503 envelope
  across query/body/path/sticker-id-resolved surfaces with cache eviction proven + version/device
  exemptions + admin unaffected + other-tenant unaffected + restore; version payload refresh after
  toggle; toggle auth/validation/404) plus updated version assertions → **229 passing**. Live
  verified on `:8080`: version false → enable → stickers 503 (exact envelope) + ads/report 503,
  version/device exempt + other tenant + admin 200 → disable → public restored; smoke data cleaned.

### Step 20 — Sticker of the Day & search autocomplete (2026-10-19)

- **Sticker of the Day (§4.15).** `src/lib/sotd.js`: deterministic weighted-random pick
  (`pickSticker`, seed = `app_id:YYYY-MM-DD`, weight = 3×downloads + shares + 1) over visible
  stickers created in the last 30 days, falling back to any visible sticker; `selectDailySticker`
  (DB) + `utcDateString`/`sotdKey`. The maintenance worker's `sotd:pick` repeatable job (§4.15,
  cron `5 0 * * *` = 00:05 UTC) pre-picks each tenant's sticker into `sotd:{app_id}:{day}`
  (TTL 2 days). Public `GET /api/stickers/daily?app_id=` returns the same DTO shape as the single
  sticker endpoint; on a cold cache it computes the same deterministic pick (single-flight) and
  caches it, and recomputes if the stored pick was hidden/removed. Hidden-only tenant → 404.
  Fixed path is registered before `/:id`.
- **Search autocomplete (§4.16).** `src/lib/search.js` gains `searchPrefixKey`
  (`search:prefix:{app_id}`), `SUGGEST_LIMIT=8`, `SUGGEST_MIN_LENGTH=2`, rebuild/TTL constants.
  The maintenance worker's `search:suggest-recompute` job (every 10 min, same 7-day window) rebuilds
  a lex-ordered ZSET of recent normalized keywords (members scored 0 so `ZRANGEBYLEX` does true
  prefix matching); stale keys are cleared. `POST /api/search` also `ZADD`s the keyword for
  freshness between rebuilds. Public `GET /api/search/suggest?app_id=&q=` normalizes `q` and returns
  up to 8 suggestions via `ZRANGEBYLEX LIMIT 0 8` (empty for `q` < 2 chars or no match).
  - Deviation: the ZSET stores **full keywords** (not bare prefixes), so `ZRANGEBYLEX` returns the
    suggestion strings the client renders. The query carries no `device_id`, so the 60/min limit is
    applied **per IP**.
- `src/worker.js` schedules the two new repeatables (worker boot verified live: `sotd:pick`
  `{apps:2,picked:2}`, `search:suggest-recompute` `{apps:2,keywords:1}`).
- Tests: +17 (`tests/unit/sotd.test.js`; `tests/integration/daily.test.js` — stability, cache-key
  reuse, recompute-on-hidden, empty tenant 404, tenant isolation/validation, worker recency window;
  `tests/integration/suggest.test.js` — lex ZSET build/old-window/stale-clear, prefix results + 8-cap,
  normalization, short/no-match empties, tenant isolation/404/validation, live-search freshness,
  60/min IP limit) → **246 passing**. Live verified on `:8080`: daily stable across calls + 404/400;
  search → suggest prefix match; worker boot scheduled both jobs.

### Step 21 — Bulk admin upload (2026-10-19)

- New dependency-free ZIP reader `src/lib/zip.js` (Node's built-in `zlib` only — no new packages):
  locates the EOCD (tolerating archive comments), walks the central directory, supports stored (0)
  and deflate (8) entries, and enforces the §4.17 limits. **Zip-slip hardened**: rejects absolute
  paths, drive letters, NUL bytes and any `..` segment; rejects encrypted entries, unsupported
  methods, per-entry >5 MB, total >100 MB, >200 entries, truncated/corrupt archives and size
  mismatches.
- `src/queues/bulk.queue.js`: `enqueueBulkUpload` builds a **BullMQ flow** — one parent
  `sticker:bulk` job plus one `sticker:upload` child per extracted image (children reuse the exact
  §4.8 Sharp→Cloudinary→DB pipeline; `ignoreDependencyOnFailure` lets the parent report partial
  success). The parent payload stores the `filename ↔ child job id` mapping.
- `POST /api/admin/stickers/bulk` (JWT + 120/min per admin): `multipart/form-data` with `zip`
  (≤50 MB) and the shared metadata fields (`app_id`, `is_premium`, `is_animated`, `emojis`, `tags`).
  Middleware `singleZip` + `verifyZipContents` check the ZIP magic bytes, parse the archive, keep
  only `.png/.jpg/.jpeg/.webp` entries and verify each entry's image magic bytes before anything is
  enqueued. Unknown tenant → 404. Responds `202 { success, job_id, total }`.
- Worker `sticker:bulk` parent handler `summarizeBulkJob` joins BullMQ child results/failures back
  to filenames and returns `{ total, completed, failed, results: [{ filename, status,
sticker_id? | error? }] }`, which `GET /api/admin/jobs/{job_id}` already surfaces (§4.17 progress
  contract).
- `src/app.js` accepts an injectable `flowProducer`; `src/worker.js` closes it on shutdown.
- Tests: +18 (`tests/unit/zip.test.js` — stored/deflate, directories/comments, zip-slip, count/size
  caps, non-zip; `tests/unit/bulk.test.js` — flow tree shape, parent/child payloads, child ids,
  result joining + missing-child failure; `tests/integration/bulk.test.js` — auth, missing zip,
  app_id validation, unknown tenant 404, 202 + flow contents, zip-slip, no-images, fake image bytes
  (415), 200-image cap) → **264 passing**. Live verified on `:8080`: ZIP upload → `202 total 2`
  (nested + stored/deflated) → worker processed both children → `GET /api/admin/jobs/{id}` reported
  `completed 2 / failed 0` with filenames; a missing-Cloudinary run correctly reported
  `completed 0 / failed 2` with per-file errors; smoke rows cleaned.

### Step 22 — Event-driven `SEARCH_MATCH` push (2026-10-19)

- Final MVP item. Implements the §4.11 `SEARCH_BASED` audience as an **event-driven** send instead of
  an admin-selectable campaign target: when a sticker with tags is uploaded, devices that searched one
  of those tags in the last **48h** and have **not checked in since that search**
  (`last_active_date < search.created_at`) get one push about the new sticker.
- `src/lib/notification.js`: `SEARCH_MATCH_WINDOW_HOURS = 48`,
  `NOTIFICATION_LOG_TYPE_SEARCH_MATCH = "SEARCH_MATCH"`.
- `src/queues/notification.queue.js`: `NotificationJob.SEARCH_MATCH = "notification:search-match"`.
- `src/workers/notification.worker.js`: new `dispatchSearchMatch({ prisma, sender, redis, data })`:
  - loads the sticker tenant-scoped and visible (`is_hidden = false`), normalizes its tag names with
    the shared §5.2 pipeline, dedupes and drops empties;
  - queries `SearchQuery` for those keywords within 48h in the same `app_id`, then applies the
    device filters (token present, notifications enabled) and the "inactive since search" rule;
  - **per-device keyword choice** (locked Phase-3 decision: trending, then most recent): ranks the
    device's matched keywords by `ZSCORE trending:search:{app_id}`; ties break on recency; if no
    keyword is in the ZSET (or Redis is absent) the most recent search wins;
  - groups recipients by identical message and sends in **batches of 500**; message is
    `New stickers for "<keyword>"` / `Fresh "<keyword>" stickers just landed. Tap to see them.` with
    string-only `data: { type, image_id, keyword }`;
  - enforces the **global 1/day/device cap** with the same atomic `NotificationLog` claim as the
    broadcast dispatcher (`type: SEARCH_MATCH`, plus `image_id`/`keyword` for auditing), releases
    claims on transient/whole-batch failures, and clears dead tokens (`FAILED` log status);
  - returns `{ image_id, matched, eligible, sent, failed, skipped_capped, dead_tokens }`.
- `src/workers/sticker.worker.js`: successful `sticker:upload` with at least one tag enqueues
  `notification:search-match` with `jobId: search-match-<image_id>` (no colon — BullMQ requirement).
  Enqueueing is **best effort**: a queue failure never fails the upload. The worker now forwards an
  injected `notificationQueue` into `processStickerJob`.
- `src/worker.js`: builds one shared notification queue and injects it into both the sticker worker
  and the notification worker (the latter also receives `redis` for trending lookups).
- Tests: +23 (`tests/unit/search-match.test.js` — contract, audience/tenant/window/tag filtering,
  activity rule, keyword preference/ties/fallbacks, 500-batch split, daily cap, dead-token clearing,
  failure release, no-op paths; `tests/integration/search-match.test.js` — real DB audience + log
  row, second same-day event capped, hidden sticker no-op, upload trigger payload/job id, no-tags and
  no-queue paths, enqueue-failure resilience) → **287 passing**. Live verified: `search-match`
  worker dry-run → `matched 1 / eligible 1 / sent 1` + `NotificationLog` row with `type
SEARCH_MATCH`; full upload → worker → notification chain with the same result; smoke jobs/rows
  cleaned.

### Step 23 — Admin audit log (2026-10-19)

- Implements the §7.8 audit trail: every admin mutation appends one immutable row (who, what, when,
  target). First post-MVP hardening step.
- `prisma/schema.prisma` + migration `20261019092843_add_audit_log`: new append-only `AuditLog` model
  `{ id, admin_id?, admin_username?, action, target_type, target_id?, app_id?, metadata Json?,
created_at }`, with **no relation to `Admin`** (history survives admin deletion) and indexes on
  `created_at`, `(app_id, created_at)`, `(admin_id, created_at)`, `(action, created_at)`.
- `src/lib/audit.js` (new): frozen `AuditAction` (13 values — `sticker.create|update|replace|delete|
hide|unhide|bulk`, `app.version.update|ads.update|maintenance.update`, `report.dismiss|resolve`,
  `notification.broadcast`) and frozen `AuditTarget` (`sticker|job|app|report|notification`), plus
  best-effort `recordAudit()` — awaited but never throws, so an audit failure cannot fail an
  already-succeeded mutation; on failure it logs via pino and resolves `null`.
- `recordAudit` wired into all 13 admin mutation controllers (create/update/replace/delete/bulk
  stickers, apps version/ads/maintenance, report dismiss/resolve, notification broadcast); failed
  requests (400/401/404) write nothing.
- `GET /api/admin/audit` (new `src/modules/admin/admin.audit.{schema,service,controller,routes}.js`):
  JWT-protected, newest-first keyset pagination, optional `app_id`/`action`/`admin_id` filters,
  `limit` capped at 100 (default 20); returns `{ success, data: [9-key DTO], next_cursor }`. The router
  registers only `GET`, so `PUT`/`DELETE` fall through to `404`.
- Tests: +27 (`tests/unit/audit.test.js` — constant contract, payload mapping, best-effort behavior;
  `tests/integration/audit.test.js` — one row per mutation across all 13 actions, no row on failed
  request, list DTO/ordering/filters/cursor/400/401, append-only 404s) → **314 passing**. Also added
  `AuditLog` cleanup to the other admin-mutation integration tests so they no longer leak rows (audit
  has no FK cascade). Live verified on `:8080`: login → hide/unhide + no-op version PUT → filtered
  audit reads returned the expected rows; `PUT`/`DELETE` → 404, no-auth → 401; smoke rows purged,
  `8080` free.

### Step 24 — Prometheus metrics (2026-10-19)

- First §8 observability item. Adds `prom-client@15.1.3` (explicitly approved) and a process-wide
  Prometheus registry.
- `src/lib/metrics.js` (new):
  - `http_requests_total` counter + `http_request_duration_seconds` histogram, both labelled
    `{ method, route, status }`; rendered as p50/p95/p99 via histogram quantiles at scrape time.
  - `metricsMiddleware`: mounted before routes, records on `finish`. Route labels use the matched
    route **pattern** (e.g. `/api/stickers/:id`, `/api/stickers`), never raw ids; unmatched paths use
    `unmatched`. Because Express 5 restores `req.baseUrl` to `""` before `finish`, the mount path is
    rebuilt from `req.originalUrl` + the relative `req.route.path` when needed, then trailing slashes
    are normalised.
  - `bullmq_queue_jobs{queue,state}` and `bullmq_queue_oldest_job_age_seconds{queue}` gauges, fed by
    `registerQueue(name, provider)`; `queueProviderFrom(queue)` adapts a BullMQ `Queue`
    (`getJobCounts()` + age of `getWaiting(0,1)`). Scrape-time (async `collect`), so no background
    polling. `app_dependency_up{dependency}` gauge via `registerDependency(name, probe)` (1/0, 0 on
    throw).
  - Scrape-time `collect` means the API never polls on a timer; `collectDefaultMetrics` adds process,
    heap, event-loop-lag and GC metrics. `__resetForTests()` isolates unit tests.
- `src/app.js`: `GET /metrics` serves the registry text (outside `/api`, so it is never rate-limited
  or blocked by tenant maintenance mode) and is excluded from access logs.
- `src/server.js`: registers the live `sticker-processing`, `notification-dispatch` and `maintenance`
  queues plus `database`/`redis` dependency probes.
- Tests: +13 (`tests/unit/metrics.test.js` — exports, counter/histogram, pattern vs raw id, unmatched,
  queue states + age, null age omitted, idempotent registration, dependency up/down/throw, full
  serialisation; `tests/integration/metrics.test.js` — `/metrics` 200 + Prometheus text, dynamic
  route pattern, unmatched, and availability during maintenance) → **327 passing**. Live verified on
  `:8080`: scrape returns `http_requests_total` (normalised route labels), real `bullmq_queue_jobs`
  states, `app_dependency_up{database|redis} 1`, and default process metrics; `8080` free.
- Note: `/metrics` is unauthenticated like `/healthz`; restrict it to the internal scrape network at
  deploy time. Worker-process metrics (via a pushgateway) are deferred.

### Step 25 — Sentry error tracking + ops docs (2026-10-19)

- Adds `@sentry/node@11.8.0` (allowed by context.md §10.3) and completes the §8 observability
  backlog except worker-process metrics.
- `src/config/env.js`: `SENTRY_DSN` (default `""`), `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`,
  `SENTRY_TRACES_SAMPLE_RATE` (0–1, default 0). Empty DSN disables reporting.
- `src/lib/sentry.js` (new): `initSentry()` lazily imports the SDK and no-ops without a DSN;
  `captureException(err, ctx)` promotes a fixed tag subset (`request_id`, `app_id`, `route`,
  `job_id`, `job_name`, `queue`, `worker`) and passes the rest via `extra`, and never throws;
  `isSentryEnabled()` plus `__setClientForTests`/`__resetForTests` seams.
- `src/middleware/errorHandler.js`: reports only true server-side failures (unexpected 500s and
  `AppError` with `status >= 500`); 4xx validation/not-found/malformed-JSON stay out of Sentry.
- `src/server.js` and `src/worker.js`: initialize Sentry at boot; worker `failed`/`error` events
  capture with job/queue/worker context (best effort).
- `docs/observability.md` (new): signal inventory, Prometheus/Sentry wiring, alert thresholds with
  PromQL, and the backup policy (Postgres PITR + daily base backups, Cloudinary raw-upload export,
  ephemeral Redis).
- `.env.example`: documented the `SENTRY_*` keys.
- Tests: +17 (`tests/unit/sentry.test.js` — init idempotency/no-DSN no-op, tag subset/extra, throw
  swallowing, seams; `tests/unit/errorHandler.sentry.test.js` — capture on 500/`AppError 500`, no
  capture on 4xx; `tests/integration/sentry.test.js` — real app 500 captured with route context,
  404 not captured) → **344 passing**. Live verified: API + worker boot with `SENTRY_DSN` empty log
  `sentryEnabled:false` and stay healthy; `8080` free.

### Step 27 — API documentation: README + OpenAPI/Swagger (2026-10-19)

- `openapi.yaml` (new, repo root): full **OpenAPI 3.0.3** document for every endpoint — public,
  admin and ops — with reusable `Error`/`Sticker`/`Report`/`AuditEntry`/`AppVersion`/`AppAds`/
  `JobStatus`/`CampaignStatus`/`AuthResponse` schemas, shared parameters (cursor, `app_id`) and
  canonical responses (`BadRequest`, `Unauthorized`, `RateLimited`, `NotFound`, `Maintenance`).
  Documents the envelope conventions, cursor pagination, admin Bearer auth and maintenance mode.
- `src/lib/openapi.js` (new): `getOpenApiSpec()` reads and memoizes the spec once per process;
  `getSwaggerHtml()` returns a self-contained Swagger UI page that loads the UI from a CDN (no new
  runtime dependency) and points at `/openapi.yaml`.
- `src/app.js`: serves `GET /openapi.yaml` (`application/yaml`) and `GET /docs` (`text/html`)
  outside `/api`, so docs are never rate-limited or blocked by tenant maintenance mode.
- `Dockerfile`: copies `openapi.yaml` into the runtime image so `/docs` works in containers.
- `README.md` (new): overview, features, architecture, tech stack, prerequisites, step-by-step
  getting started, env-var and script tables, the full endpoint map, project structure, testing,
  workers, deployment (Docker/CI) and observability pointers.
- `.env.example`: `PORT` corrected from `3000` to `8080` to match the documented dev port.
- Tests: +3 (`tests/integration/docs.test.js` — spec served with a YAML content type, Swagger page
  references the spec, both reachable during maintenance) → **347 passing**.
- Live verified: `/openapi.yaml` → `200 application/yaml`, `/docs` → `200 text/html` referencing
  `/openapi.yaml`; `8080` released after shutdown. Prettier normalization applied to
  `CHANGELOG.md`, `docs/observability.md` and `openapi.yaml`.

### Step 26 — Ops: git repo, CI, Docker (2026-10-19)

- Initialized the git repository (branch `main`). No commit is created — the working tree is left
  staged/untracked for review (commits are made only on explicit request).
- `.github/workflows/ci.yml` (new): on push to `main` and pull requests, spins up Postgres 16 +
  Redis 7 services, then `npm ci` → `npx prisma generate` → `npx prisma migrate deploy` →
  `npm run lint` → `npm test`.
- `Dockerfile` (new): multi-stage. Build stage installs deps, runs `prisma generate`, and prunes
  dev dependencies; runtime stage (`node:22-bookworm-slim` + `openssl`) runs as the non-root `node`
  user on port 8080. The same image runs the API (`node src/server.js`) or the worker
  (`node src/worker.js`). Migrations are applied out-of-band (`npm run db:migrate:deploy`).
- `.dockerignore` (new): excludes `.git`, tests, docs, env files and local compose config.
- `docker-compose.yml`: added `api` and `worker` services behind the `app` profile
  (`docker compose --profile app up -d --build`); the default `up` still starts only Postgres + Redis.
- `package.json`: added `db:migrate:deploy`.
- Note: the Dockerfile and compose app services could not be built in this sandbox (no Docker CLI);
  they are syntactically validated (YAML) and written to be buildable. CI is likewise not runnable
  here (no GitHub runner).
