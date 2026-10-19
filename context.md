## Project: Production-Grade Multi-Tenant Sticker API (Node.js & JavaScript) — ENHANCED CONTEXT v2.2

> **Change log vs. original v1:** fixes 7 schema/spec conflicts found during expert review, adds a caching/queue
> layer, hardens security, and defines concrete performance budgets for a 5,000+ DAU baseline.
> **v2.1 (product decisions):** removed `min_version` (replaced by admin-controlled `force_update`),
> trending formula now weights downloads 3× shares, complete 6-unit AdMob inventory.
> **v2.2 (promoted features):** moderation (Report + `is_hidden` soft-delete), Sticker of the Day + streaks,
> search autocomplete, bulk admin upload, maintenance mode — all moved from backlog to core spec (§4.14–4.18).
> Firebase Admin SDK confirmed as the ONLY push channel.
> Sections marked 🆕 are new. Sections marked 🔧 contain corrections — these OVERRIDE the original document.

---

## SECTION 1: Architecture Overview & System Philosophy

### 1.1 Core Identity

A robust, high-performance, multi-tenant backend API using **Node.js, Express.js, and Pure JavaScript (NO TypeScript)**,
powering two client applications across multiple app tenants:

1. **Android Mobile Application (Client End-Users):** smooth scrolling feeds, offline-first favorite queueing, deep-linking, smart engagement triggers, dynamic ad configuration.
2. **React Admin Dashboard (Web Management):** token-protected administration for sticker upload/processing/moderation, tenant version management, ad network configuration, and targeted FCM campaigns.

### 1.2 Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime | Node.js (ES Modules) | `"type": "module"`, Node ≥ 20 LTS |
| Framework | Express.js (REST) | `express-async-handler` or wrapper for async errors |
| Database & ORM | PostgreSQL + Prisma | Connection pool capped (see §6.4) |
| Cache / Queue / Rate-limit store 🔧🆕 | **Redis 7** (ioredis) | Mandatory. Used for: feed caching, trending cache, ad/version config cache, rate limiting, BullMQ backing store |
| Background jobs 🆕 | **BullMQ** | Image-processing jobs, FCM fan-out campaigns, SearchQuery purge, analytics rollups |
| Cloud Storage & CDN | Cloudinary | Store `public_id` in DB (see §3 fix) |
| Image Processing | Sharp | 🔧 **Runs in BullMQ worker processes, NOT in the Express request path** (see §6.2) |
| Validation & Security | Zod, bcrypt, jsonwebtoken | Plus helmet, cors, express-rate-limit (Redis-backed) |
| Push | Firebase Admin SDK | Server-side FCM only |
| Logging/Observability 🆕 | pino, OpenTelemetry, Sentry | Structured JSON logs; trace IDs on every request |

### 1.3 Architecture Shape 🆕

```
Android App ──► Express API (stateless, N replicas behind load balancer)
                    │
                    ├──► PostgreSQL (Prisma, pooled)
                    ├──► Redis ──► cache reads / rate limits / BullMQ
                    └──► Cloudinary (assets)

BullMQ Workers (separate processes):
  - image-processing.worker   (Sharp 512×512 WebP → Cloudinary upload)
  - fcm-dispatch.worker       (batch FCM sends, invalid-token cleanup)
  - maintenance.worker        (SearchQuery 15-day purge, trending rollup)
```

---

## SECTION 2: Strict Governance (MUST DO & DON'T DO)

### MUST DO

1. **Pure JavaScript exclusively.** No TypeScript, no `.ts` files, no type build step. JSDoc for hints.
2. **WhatsApp sticker compliance.** Every upload passes through Sharp → WebP, exactly 512×512.
3. **Write-throttling.** `DeviceProfile.last_active_date` updated **once per day per device**; skip write if date already equals today (`YYYY-MM-DD` in the app's canonical timezone, UTC). Scheduled purge of `SearchQuery` records older than 15 days (via BullMQ repeatable job).
4. **Strict route separation.** `/api/...` public (lightweight, optimized, unauthenticated where specified) vs. `/api/admin/...` (JWT Bearer middleware).
5. **Environment configuration.** No hardcoded secrets; everything via `dotenv` + `process.env`; validate env with Zod at boot — **fail fast** if missing.
6. 🆕 **Tenant isolation everywhere.** Every public query that reads stickers, searches, or devices MUST filter by `app_id`. A sticker ID from tenant A must never be readable via tenant B's app. See §4 fixes.
7. 🆕 **Validate every input with Zod** on every endpoint (query, params, body). Never trust `req.params.id` is a UUID.
8. 🆕 **Cache hot reads in Redis with short TTLs.** Ad config and app version are fetched on every app launch — they are the highest-QPS endpoints (see §6.3).
9. 🆕 **All heavy work off the request path.** Sharp processing, Cloudinary uploads, and FCM fan-out happen in BullMQ workers. HTTP endpoints only enqueue jobs and return job IDs/202 where applicable.

### DON'T DO

1. **NO TypeScript** — no `tsconfig.json`, no `.ts` files, no type-checking build tools.
2. **NO unchecked database writes** — no blind timestamp updates or blind search logging; always throttle/normalize first.
3. **NO blended endpoints** — admin actions never live in public routes.
4. 🔧 **NO Sharp processing inside Express request handlers.** Sharp on large animated files blocks/saturates the event loop; it must run in a worker process.
5. 🔧 **NO unbounded growth** — every table that grows per-request (`SearchQuery`, `Favorite`, engagement events) has a TTL purge or rollup job.
6. 🔧 **NO offset pagination** (`skip`/`take` with large offsets) on any list endpoint — cursor-only.

---

## SECTION 3: Database Schema (`prisma/schema.prisma`) — CORRECTED 🔧

The original schema had 7 conflicts with the feature spec. This corrected schema is the new source of truth.

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

model App {
  id                          String   @id @default(uuid())
  name                        String
  package_name                String   @unique
  target_version              Int      @default(1)
  force_update                Boolean  @default(false)  // 🔧 admin-controlled mandatory update flag
  maintenance_mode            Boolean  @default(false)  // v2.2: public API returns 503 while true (§4.18)
  ads_enabled                 Boolean  @default(true)
  admob_banner                String?
  admob_interstitial          String?
  admob_rewarded              String?                      // rewarded ad (user earns reward for watching)
  admob_rewarded_interstitial String?                      // rewarded interstitial (opt-in mid-flow)
  admob_openad                String?
  admob_native                String?
  created_at                  DateTime @default(now())
  images                      Image[]
  devices                     DeviceProfile[]
  search_queries              SearchQuery[]
  favorites                   Favorite[]
  reports                     Report[]
}

model DeviceProfile {
  device_id        String   @id
  app_id           String
  fcm_token        String?
  last_active_date DateTime @default(now())
  streak_count     Int       @default(0)     // v2.2: consecutive daily-active days (§4.15)
  last_streak_date DateTime?                // v2.2: last day the streak was incremented
  app              App      @relation(fields: [app_id], references: [id], onDelete: Cascade)
  created_at       DateTime @default(now())
  updated_at       DateTime @updatedAt

  @@index([app_id])
  @@index([app_id, last_active_date])   // 🆕 FIX 3: powers INACTIVE campaign targeting (≥3 days old)
}

model Image {
  id                   String   @id @default(uuid())
  app_id               String
  image_url            String
  cloudinary_public_id String                                // 🆕 FIX 4: required to delete asset from Cloudinary
  is_animated          Boolean  @default(false)
  is_premium           Boolean  @default(false)
  is_hidden            Boolean  @default(false)           // v2.2: soft-delete / moderation flag (§4.14)
  emojis               String[]
  downloads            Int      @default(0)
  shares               Int      @default(0)
  app                  App      @relation(fields: [app_id], references: [id], onDelete: Cascade)
  tags                 Tag[]
  favorites            Favorite[]
  reports              Report[]
  created_at           DateTime @default(now())
  updated_at           DateTime @updatedAt                  // 🆕 FIX 5: admin edits must be tracked

  @@index([app_id])
  @@index([app_id, created_at])          // 🆕 cursor pagination on "latest"
  @@index([app_id, downloads, shares])   // 🆕 trending sort support
}

model Tag {
  id     String @id @default(uuid())
  name   String @unique
  images Image[]
}

model SearchQuery {
  id         String   @id @default(uuid())
  app_id     String
  device_id  String
  keyword    String
  created_at DateTime @default(now())
  app        App      @relation(fields: [app_id], references: [id], onDelete: Cascade)

  @@index([app_id, created_at])          // supports purge + trending aggregation
}

// 🆕 FIX 6: the batch-favorites endpoint existed with NO table to store data into.
// This table was missing from the original spec — without it, the entire "Offline Favorites" feature was a no-op.
model Favorite {
  id         String   @id @default(uuid())
  device_id  String
  app_id     String
  image_id   String
  created_at DateTime @default(now())
  app        App      @relation(fields: [app_id], references: [id], onDelete: Cascade)
  image      Image    @relation(fields: [image_id], references: [id], onDelete: Cascade)

  @@unique([device_id, image_id])        // idempotent ADD/REMOVE
  @@index([app_id, device_id])           // fast per-device favorite listing
  @@index([created_at])                  // TTL purge (optional)
}

// v2.2: content moderation (§4.14) — user reports feed an admin review queue.
model Report {
  id         String   @id @default(uuid())
  app_id     String
  device_id  String
  image_id   String
  reason     String   // e.g. "inappropriate", "copyright", "spam", "other" (validated enum in Zod)
  status     String   @default("OPEN") // OPEN | REVIEWED | DISMISSED
  created_at DateTime @default(now())
  app        App      @relation(fields: [app_id], references: [id], onDelete: Cascade)
  image      Image    @relation(fields: [image_id], references: [id], onDelete: Cascade)

  @@unique([device_id, image_id])  // idempotent: one report per device per sticker
  @@index([app_id, status, created_at])
}

model Admin {
  id       String @id @default(uuid())
  username String @unique
  password String // Hashed via bcrypt (cost ≥ 12)
}
```

---

## SECTION 4: Endpoints — Spec with Corrections

### PART A: Android Client

#### 4.1 Device Registration & Throttled Activity — `POST /api/auth/device`

| Property | Value |
|---|---|
| Route | `POST /api/auth/device` |
| Access | Public, rate-limited: 30 req/min per IP + 60 req/min per device_id |
| Body | `{ device_id: string (1–128), fcm_token: string (≤512), app_id: uuid }` — all Zod-validated |

Behavior:
- Upsert on `device_id` (`create` or `update`). App must exist (validate `app_id` — silently reject unknown tenants).
- **Daily throttle:** read `last_active_date`; if it equals today (UTC `YYYY-MM-DD`), skip the `last_active_date` write entirely (FCM token may still be updated only if it changed — compare before writing).
- Response: `{ success: true, message: "Device profile and FCM token synchronized successfully." }`

#### 4.2 Paginated Feeds & Trending — `GET /api/stickers`

| Property | Value |
|---|---|
| Route | `GET /api/stickers` |
| Query | `cursor` (optional), `limit` (default 20, **max 50 — enforced**), `app_id` (required, uuid), `search` (optional, ≤64 chars, normalized), `sort_by` (`trending` \| `latest`, default `latest`) |
| Cache 🆕 | `latest` per (app_id, cursor, limit, search): Redis TTL **60s**. `trending`: Redis TTL **300s** (see §5.1 for why). |

**🔧 FIX 7 (tenant leak):** `GET /api/stickers/{id}` and list endpoints MUST include `app_id` in the WHERE clause for all public queries. Admin routes may query cross-tenant.
**v2.2:** every public sticker read (feed, single, trending, search, daily) MUST also filter `is_hidden = false`. Hidden stickers exist only in admin views.

**Trending pagination note 🔧:** trending scores change every download/share, so a pure score-cursor drifts between pages. Solution: trending results are **computed into a Redis sorted set every 5 minutes** per app; paginate against that stable snapshot with cursor = last item's score+id tuple. Implement via the maintenance worker.

#### 4.3 Deep Link Single Sticker — `GET /api/stickers/{id}`

- Public; Zod-validate UUID; **include `app_id` filter**; rate-limited 120 req/min/IP.
- 404 body: `{ success: false, error: { code: "STICKER_NOT_FOUND", message: "..." } }` — consistent error envelope everywhere.

#### 4.4 Engagement Trackers — `POST /api/stickers/{id}/download` & `/share`

- 🔧 **Abuse control (was fully open):** rate limit 60 req/min per device_id + 300 req/min per IP; validate `device_id` format; verify sticker exists in the same `app_id` as implied by context. Fire-and-forget: increment via a BullMQ job (`sticker:increment-counter`) so the hot path never blocks on a write — trending tolerance is ±minutes, not ±milliseconds.
- Response: `{ success: true, current_downloads: 1451 }` — read the counter from the job result or DB; if using the job, return `downloads + 1` optimistically.

#### 4.5 Bulk Favorites — `POST /api/user/favorites/batch` 🔧 (now actually persists)

| Property | Value |
|---|---|
| Route | `POST /api/user/favorites/batch` |
| Body | `{ device_id, app_id, favorite_image_ids: uuid[] (max 200), action: "ADD" \| "REMOVE" }` |

- Wrapped in a single Prisma `$transaction`: `createMany({ skipDuplicates: true })` for ADD; `deleteMany` for REMOVE.
- **Idempotent by design** (`@@unique([device_id, image_id])`) — safe for Android's local queue to re-flush on retry.
- Response: `{ success: true, processed_count: 3, message: "Batch favorites synchronized successfully." }`
- 🆕 `GET /api/user/favorites?device_id=&app_id=&cursor=&limit=` — required so the Android app can re-hydrate local state after reinstall.

#### 4.6 Search Logging & Trending

- `POST /api/search` — normalize keyword (§5.2), reject empty result, rate limit 30 req/min per device. Insert directly (single-row writes are cheap; at 5k DAU this is far below write capacity).
- `GET /api/search/trending?app_id=&limit=` (default 10, max 30) — **serve from Redis** (ZSET `trending:search:{app_id}`, rebuilt every 10 min by maintenance worker via `GROUP BY keyword` on last-7-day window). Never run the aggregation query per HTTP request.
- Purge: BullMQ repeatable job daily 03:00 UTC: `DELETE FROM "SearchQuery" WHERE created_at < NOW() - INTERVAL '15 days'`.

### PART B: Admin

#### 4.7 Auth — `POST /api/admin/login`

- bcrypt compare (cost ≥ 12), constant-time response, JWT access token (HS256, **15 min expiry**) + **httpOnly refresh token** (7 days, stored hashed in Redis or a `RefreshToken` table). 🔧 The original spec's single non-expiring token is a security defect.
- Rate limit 10 attempts/min/IP + account lockout backoff after 5 failures.

#### 4.8 Sticker Upload — `POST /api/admin/stickers` 🔧 (async pipeline)

| Property | Value |
|---|---|
| Route | `POST /api/admin/stickers` |
| Access | JWT Bearer (`Authorization: Bearer <token>`) |
| Content-Type | `multipart/form-data`; `image` file ≤ 5 MB, mime allowlist `image/png, image/jpeg, image/webp` |

Flow (admin sees `202 Accepted` + `job_id`, result delivered via `GET /api/admin/jobs/{job_id}` or websocket):
1. `multer` memory storage (strict size cap) → validate with Zod → enqueue BullMQ job.
2. **Worker:** Sharp pipeline → resize/cover to exactly 512×512 → WebP (quality 82, effort 4; animated WebP via Sharp only if source is animated and ≤ 30 frames — else reject) → upload to Cloudinary (`folder: tenants/{app_id}`, `resource_type: image`, `format: webp`) → create `Image` row + connect `Tag`s (upsert tags by name) in one transaction.
3. Cloudinary naming: use `admob_*` schema fields consistently; **renamed `admob_rewarded` → `admob_rewarded_interstitial`** in the admin ads endpoint to match the schema.

#### 4.9 Sticker Update — `PUT /api/admin/stickers/{id}`

- `multipart/form-data` (optional new `image`) or `application/json`.
- Metadata-only path: single update in a transaction (disconnect/reconnect tags).
- New-image path: enqueue the same worker job with `replace: imageId`; worker deletes the old Cloudinary asset via `cloudinary_public_id` (requires FIX 4), then re-creates.

#### 4.10 Sticker Delete — `DELETE /api/admin/stickers/{id}`

1. Delete DB row (cascades favorites, reports).
2. Enqueue job to destroy Cloudinary asset by `cloudinary_public_id`.
3. Evict Redis caches for that app: `stickers:*:{app_id}*`, `trending:stickers:{app_id}`.

**v2.2:** hard delete is reserved for confirmed abuse/copyright removal. The normal moderation flow is the soft-delete hide/unhide pair in §4.14 — content disappears from all public surfaces instantly but remains reviewable/recoverable.

#### 4.11 FCM Campaign Dispatcher — `POST /api/admin/notifications/broadcast` 🔧 (async, batched)

Targeting:
- `INACTIVE`: `last_active_date <= today - 3 days` (uses FIX 3 index).
- `SEARCH_BASED`: devices with a `SearchQuery` in last 48h whose `last_active_date` < that search time.
- `ALL`: every device under `app_id`.

🔧 **Push channel (v2.2, product decision): Firebase FCM via Firebase Admin SDK is the ONLY push mechanism — server-side, no native/self-hosted push gateway.** Client-side token refresh is handled by the Android app re-calling `POST /api/auth/device` with the new token (upsert overwrites the old one).
Flow: enqueue job → worker loads token list in **batches of 500** (FCM multicast limit), sends via Admin SDK multicast, collects `registration-token-not-registered` errors and **nulls/deletes dead FCM tokens** (keeps the table clean). Response is `202 { success: true, campaign_id, targeted_devices_count: 1250 }`; final result queryable by campaign id.

#### 4.12 App Version Management 🔧

- Public `GET /api/apps/{app_id}/version?current_version=` → **Redis-cached, TTL 60s** (hottest endpoint on app launch). Response: `{ success, app_id, target_version, force_update, update_required }`, where `update_required = force_update && current_version < target_version` (computed server-side; client only acts on `update_required` and `target_version`).
- Admin `PUT /api/admin/apps/{app_id}/version` → body `{ target_version: int, force_update: boolean }` → update → evict cache. 🔧 `min_version` was removed from v2.1 per product decision: `target_version` + admin-controlled `force_update` covers both optional-update prompts and mandatory-update blocks with one simpler mechanism.

#### 4.13 Ad Configuration 🔧

- Public `GET /api/apps/{app_id}/ads` → Redis-cached, TTL 60s.
- Admin `PUT /api/admin/apps/{app_id}/ads` → validate unit-ID format (`/^ca-app-pub-\d+\/[\w-]+$/`) → update → evict cache.

**Complete AdMob unit inventory (all optional per tenant):**

| Field | AdMob Format | Typical Use in Sticker Apps |
|---|---|---|
| `admob_banner` | Banner (incl. Adaptive/Anchored) | Persistent feed footer |
| `admob_interstitial` | Interstitial | Between sticker-pack views / on export |
| `admob_rewarded` | Rewarded | Watch ad to unlock `is_premium` packs |
| `admob_rewarded_interstitial` | Rewarded Interstitial | Opt-in reward at natural breakpoints |
| `admob_openad` | App Open | Shown on cold start / return to foreground |
| `admob_native` | Native Advanced | In-feed sponsored-slot styling |

All six are independently nullable; the Android client renders only units that are present AND `ads_enabled = true`. Field names match the schema exactly.

---

### PART C: Content Safety & Engagement Features (promoted from backlog, v2.2)

#### 4.14 Content Moderation & Reporting

**Public — report a sticker:** `POST /api/stickers/{id}/report`
- Body: `{ device_id, reason: "inappropriate" | "copyright" | "spam" | "other" }` — Zod-validated enum.
- Idempotent: `@@unique([device_id, image_id])` — duplicate reports from the same device update the existing row's `created_at`, never spam the queue.
- Rate limit: 10 reports/min per device. Response: `{ success: true }` (always generic — do not leak moderation state).

**Admin — review queue:** `GET /api/admin/reports?status=OPEN|REVIEWED|DISMISSED&app_id=&cursor=&limit=`
**Admin — soft delete:** `POST /api/admin/stickers/{id}/hide` → sets `is_hidden = true`; `POST /api/admin/stickers/{id}/unhide` → restores. Both evict the app's Redis caches immediately.
**Admin — triage:** `POST /api/admin/reports/{id}/dismiss` or `/resolve`.
- Hiding is instant and reversible; hard delete (§4.10) remains only for confirmed removals.

#### 4.15 Sticker of the Day & Streaks

**Sticker of the Day** — deterministic, zero-DB-read for clients:
- Maintenance worker sets Redis key `sotd:{app_id}:{YYYY-MM-DD}` at 00:05 UTC: picks one visible sticker per app (weighted random over stickers with `created_at` ≤ 30 days, fallback to any visible sticker).
- `GET /api/stickers/daily?app_id=` → cached read, response shape identical to a single sticker. Same sticker for every user that day (deterministic, shareable).

**Streaks** — tracked on the already-throttled daily path, so it costs zero extra writes:
- In `POST /api/auth/device`, when the daily check detects a new day: `streak_count = (last_streak_date == yesterday) ? streak_count + 1 : 1`, `last_streak_date = today`. Write rides along with the existing daily-throttled update.
- `GET /api/auth/device?device_id=&app_id=` → returns `{ streak_count, last_active_date }` so the Android client can render streak UI.
- FCM hook: new `target_type: STREAK_AT_RISK` in §4.11 — targets devices with `streak_count >= 3` and `last_streak_date <= today - 1 day`. Motivational body: "Your 7-day streak is about to break!"

#### 4.16 Search Autocomplete

- `GET /api/search/suggest?app_id=&q=` — returns up to 8 suggestions.
- Backing store: Redis ZSET `search:prefix:{app_id}` rebuilt every 10 min by the maintenance worker from the last-7-day normalized `SearchQuery` rows (same window as trending search).
- Implementation: insert each keyword plus every prefix (2 chars minimum, e.g. `ca`, `cat`, `cats`) as lex-scored members; serve via `ZRANGEBYLEX`. Response: `{ success: true, suggestions: ["cats", "cat memes", ...] }`.
- Rate limit: 60 req/min per device.

#### 4.17 Bulk Admin Upload

- `POST /api/admin/stickers/bulk` — `multipart/form-data`: `zip` file (≤ 50 MB, ≤ 200 images, allowlist png/jpeg/webp inside), plus shared metadata fields (`app_id`, `is_animated`, `is_premium`, `emojis`, `tags`) applied to every extracted image.
- Worker flow: validate zip entries (reject path traversal / zip-slip), then **one BullMQ child job per extracted file**, each reusing the exact §4.8 single-upload Sharp→Cloudinary→DB pipeline. Parent job aggregates child states.
- `GET /api/admin/jobs/{job_id}` → `{ success, total, completed, failed, results: [{ filename, status, sticker_id? | error? }] }` — powers the dashboard progress UI.
- Response to the POST itself: `202 { success: true, job_id }`.

#### 4.18 Maintenance Mode

- `App.maintenance_mode Boolean @default(false)`. Public middleware on `/api/*` (applied before routers): when the flag is true, **all public endpoints except `GET /api/apps/{app_id}/version` and `POST /api/auth/device` return** `503 { success: false, error: { code: "MAINTENANCE_MODE", message: "Service temporarily unavailable. Please try again soon." } }`.
- The two exemptions let the Android client still receive version/maintenance info and keep FCM tokens fresh; everything else is frozen.
- Admin routes are unaffected. Toggle: `PUT /api/admin/apps/{app_id}/maintenance` body `{ maintenance_mode: boolean }` → update → evict `version:{app_id}` cache.
- Redis-cached public responses MUST be validated against the flag (check the cached `version:{app_id}` payload or check flag before serving from other caches — cheap, one extra key read).

---

## SECTION 5: Core Algorithms

### 5.1 Trending Score — DEFINED (was unspecified in v1)

Computed per sticker (age in hours since `created_at`, UTC):

```
score = (downloads * 3.0 + shares * 1.0) / POW(age_hours + 2.0, 1.5)
```

- 🔧 **Downloads weigh 3× shares (v2.1, per product decision):** the primary sticker action is *add-to-WhatsApp*, which fires the download counter — shares are rare. Weighting downloads higher makes trending reflect actual usage, not link-sharing.
- Shares still contribute — they are a strong freshness/virality signal even at low volume.
- +2h floor prevents brand-new items with 0 engagement from dividing by zero or exploding to infinity.
- Exponent 1.5 gives strong time decay — legacy items fade in ~days, not weeks.
- Implementation: maintenance worker recomputes per app every 5 min into Redis ZSET `trending:stickers:{app_id}` (member = image_id, score = score). API reads the ZSET in reverse with cursor = `(score, id)`. Counter increments push a lightweight `ZINCRBY` so the set stays fresh between recomputes.

### 5.2 Search Normalization Pipeline

```js
const normalizeKeyword = (raw) =>
  raw
    .normalize("NFKD")                 // strip diacritics
    .replace(/[\u064B-\u0652]/g, "")   // strip Arabic tashkeel
    .replace(/[\u0300-\u036f]/g, "")   // combining marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")      // punctuation → space
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
```

Reject empty results. Store the normalized form only.

### 5.3 Daily Activity Throttle (pseudocode)

```js
const today = new Date().toISOString().slice(0, 10); // UTC
const existing = await prisma.deviceProfile.findUnique({ where: { device_id } });
if (!existing) { /* create with last_active_date = today */ }
else {
  const activeDay = existing.last_active_date.toISOString().slice(0, 10);
  const fcmChanged = existing.fcm_token !== fcm_token;
  if (activeDay !== today || fcmChanged) {
    await prisma.deviceProfile.update({
      where: { device_id },
      data: {
        ...(activeDay !== today && { last_active_date: new Date() }),
        ...(fcmChanged && { fcm_token }),
      },
    });
  }
  // else: zero writes — request served read-only
}
```

---

## SECTION 6: Performance & Scaling Plan (5,000 DAU baseline and beyond) 🆕

### 6.1 Load math (sanity check)

5,000 DAU ≈ 300–800 concurrent users at peak, ~5–15 RPS average, ~50–100 RPS burst.
**This is small for PostgreSQL/Node.** The system as specced handles it easily — the real risks are *design* risks (event-loop blocking, unbounded tables, hot un-cached reads, FCM fan-out storms), not raw capacity.

### 6.2 Never block the event loop

- Sharp, Cloudinary uploads/downloads, FCM sends, CSV/aggregate work → **BullMQ workers only**.
- Express replicas stay stateless and horizontally scalable behind a load balancer.
- Worker concurrency: 2–4 per queue per process; scale by adding worker processes.

### 6.3 Caching strategy (Redis)

| Data | Key pattern | TTL | Invalidation |
|---|---|---|---|
| Sticker list pages | `stickers:{app_id}:{hash(query)}` | 60s | on admin CUD of that app |
| Trending ZSET | `trending:stickers:{app_id}` | rebuilt 5 min | worker-managed |
| Trending search | `trending:search:{app_id}` | rebuilt 10 min | worker-managed |
| Ad config | `ads:{app_id}` | 60s | on admin PUT |
| App version | `version:{app_id}` | 60s | on admin PUT |
| Single sticker | `sticker:{id}` | 300s | on admin CUD |

Cache miss → single-flight (per-request in-memory promise guard) to prevent stampedes.

### 6.4 Database

- Prisma connection pool: `connection_limit` sized to `(PG max_connections / API replica count) - headroom` (start: 10 per replica).
- All list queries cursor-based on indexed columns (see §3 indexes). `take: limit + 1` trick for `next_cursor`.
- Purge `SearchQuery` daily; at 5k DAU ≈ 15k rows/day worst case — trivial, but the job is mandatory so 100k+ DAU doesn't require an emergency migration.
- Quarterly review: consider monthly partitions on `SearchQuery(created_at)` once volume justifies it.

### 6.5 Rate limiting (Redis-backed, sliding window)

| Surface | Limit |
|---|---|
| Global API | 300 req/min/IP |
| `/api/auth/device` | 30/min IP, 60/min device |
| `/api/search*` | 30/min device |
| Download/share | 60/min device, 300/min IP |
| `/api/admin/login` | 10/min IP + lockout |
| Admin mutations | 120/min per admin |

### 6.6 FCM fan-out

- Campaigns are jobs, not requests. 1250 devices = 3 multicast batches of 500.
- Dead-token cleanup inside the worker keeps `fcm_token` column healthy and targeting accurate.

---

## SECTION 7: Security Hardening 🆕

1. helmet (secure headers), CORS allowlist per tenant dashboard origin.
2. JWT: 15-min access + httpOnly refresh; secret ≥ 32 bytes from env; never log tokens.
3. bcrypt cost ≥ 12; seed the initial admin only via a one-time script, never via an endpoint.
4. Zod-validate **params, query, body, headers** on every route; consistent error envelope `{ success: false, error: { code, message, details? } }`.
5. Multer: memory storage, 5 MB cap, mime allowlist, file-signature check (magic bytes), random storage names.
6. Cloudinary: signed uploads from worker only; restrict destroy permissions to server.
7. Rate limits per §6.5; Redis store shared across replicas.
8. Audit log (append-only table or log stream) for every admin mutation: who, what, when, target id.
9. Secrets via env only; `.env` never committed; provide `.env.example`.

---

## SECTION 8: Observability & Operations 🆕

- **pino** JSON logs with `request_id`, `device_id` (hashed), `app_id`, latency, route.
- **Health endpoints:** `/healthz` (liveness), `/readyz` (DB + Redis ping).
- **Metrics:** OpenTelemetry → Prometheus: RPS, p50/p95/p99 latency per route, DB pool saturation, Redis memory, queue depth/age, FCM success rate.
- **Alerting:** p95 > 500 ms on feed endpoints, queue age > 60 s, error rate > 1%, Redis/DB down.
- **Error tracking:** Sentry on API and workers.
- **Backups:** managed PG PITR + daily Cloudinary backup of raw uploads.

---

## SECTION 9: Multi-Tenancy & Client Isolation

- Single API, multiple tenants, strict `app_id` scoping on every public query.
- Unknown/invalid `app_id` → generic 404 (don't leak tenant existence).
- Per-tenant caches, per-tenant rate-limit buckets, per-tenant FCM campaigns.
- Admin dashboard authenticates admins globally; tenant selection enforced server-side per admin's allowed apps.

---

## SECTION 10: OpenCode Multi-Agent Workflow

1. **Read this file first.** It supersedes any earlier `context.md`.
2. Update `CHANGELOG.md` after each module; maintain `project_state.md` (current branch, done/todo, key decisions) to avoid re-reading code across handoffs.
3. **Stack discipline:** Pure JavaScript, Node ≥ 20, ESM. Allowed additions beyond v1 stack: Redis (ioredis), BullMQ, pino, helmet, express-rate-limit, OpenTelemetry/Sentry, multer, firebase-admin. **No other new dependencies without explicit approval.**
4. Every endpoint: Zod schema → controller → service → Prisma. No business logic in route files.
5. Every list endpoint: cursor pagination, `limit` capped, Redis cache where §6.3 says so.
6. Every worker: idempotent, retriable with backoff (BullMQ `attempts: 3, backoff: exponential`), safe to run twice.
7. Migrations: `prisma migrate dev` locally, `prisma migrate deploy` in CI; never edit applied migrations.

---

## SECTION 11: Optional Feature Backlog (post-MVP, not in scope yet) 🆕

Candidate features — implement only after the core system ships.
**Note:** Sticker Packs are *intentionally excluded* — the product serves individual images and the client composes packs from user selection. Scope is API-only for now (no Android-specific work in this repo).

1. **Categories beyond tags** — curated, admin-ordered horizontal feed sections ("Trending", "New", "Love", "Memes") via a `Category` + `CategoryImage` model.
2. **Per-device analytics opt-in** — anonymized favorite/download history powering "Recommended for you" (start with same-tag co-occurrence; collaborative filtering later).
3. **A/B ad placement config** — JSON `ad_slots` field letting admins toggle *where* units render (feed footer, export screen, open-ad) without an app release.
4. **Localization-ready tags** — `Tag.name_en`, `Tag.name_ar` etc., so one sticker library serves multilingual search.

---

## APPENDIX A: Conflicts Found in v1 — All Fixed in This Document 🔧

| # | Conflict / Risk | Fix |
|---|---|---|
| 1 | Version endpoint referenced `min_version`, absent from schema | 🔁 v2.1: removed `min_version` entirely; `target_version` + admin-controlled `force_update` instead |
| 2 | Admin ads body vs. schema unit names mismatched | Full 6-unit AdMob inventory defined (banner, interstitial, rewarded, rewarded interstitial, app open, native) with exact schema field names |
| 3 | Batch-favorites endpoint existed with **no `Favorite` table** — feature was a no-op, data loss | Added `Favorite` model with unique key + index + `GET /api/user/favorites` |
| 4 | Cloudinary deletion impossible — no `public_id` stored | Added `cloudinary_public_id` |
| 5 | `Image` had no `updated_at` despite admin modification feature | Added `updated_at @updatedAt` |
| 6 | Public sticker endpoints had no `app_id` scoping — cross-tenant data leak | Mandatory tenant filter on all public reads (§4.2) |
| 7 | Trending algorithm "defined" but formula unspecified; score-cursor pagination unstable | Concrete gravity formula (§5.1), downloads-weighted per product decision + Redis ZSET snapshot pagination |
| 8 | Download/share counters open to counter-inflation abuse | Device+IP rate limits, validated writes, async increments |
| 9 | Admin JWT single non-expiring token | 15-min access + httpOnly refresh, lockout on login |
| 10 | Sharp/Cloudinary/FCM in request path → event-loop stalls at traffic spikes | BullMQ worker architecture (§1.3) |
| 11 | Ad & version endpoints (every app launch) hitting DB directly | Redis cache, 60 s TTL, explicit invalidation |
| 12 | Trending-search aggregation on every HTTP request | Pre-aggregated ZSET rebuilt every 10 min |

_This document is the single source of truth for the Production-Grade Multi-Tenant Sticker API. Where it conflicts with the original v1 context, this version (v2.0) prevails._
