# api-stiker

Production-grade, multi-tenant **Sticker API** in **Node.js (ES Modules) + Express + Prisma**.
One stateless API powers the Android sticker client and a React admin dashboard across
multiple app tenants, with Redis-backed caching, BullMQ background workers, FCM push, and
Cloudinary asset storage.

- **Language:** pure JavaScript (no TypeScript) — JSDoc for hints, Node >= 20 LTS.
- **Spec:** [`context.md`](./context.md) is the single source of truth for product/technical behavior.
- **API reference:** interactive Swagger UI at `/docs`, raw spec at [`openapi.yaml`](./openapi.yaml).

---

## Features

**Client (public API)**

- Cursor-paginated sticker feed with `latest` / `trending` sorting, tag/free-text search.
- Deep-link single sticker, deterministic Sticker of the Day.
- Download / share engagement counters (async, abuse-limited).
- Device registration with daily activity write-throttling + daily streaks.
- Offline favorites batch sync (idempotent) with re-hydration listing.
- Search logging, trending keywords, and prefix autocomplete.
- Per-tenant ad configuration (full 6-unit AdMob inventory) and app version / update policy.

**Admin API (JWT-protected)**

- bcrypt login with short-lived access token + rotating httpOnly refresh cookie and lockout.
- Single and bulk (ZIP) sticker upload → Sharp → Cloudinary → DB via workers.
- Sticker update / delete, hide/unhide moderation, report review queue.
- FCM broadcast campaigns (`ALL` / `INACTIVE`), campaign status.
- App version, ad, and maintenance-mode management.
- Append-only audit trail for every mutation.

**Platform**

- Strict tenant isolation (`app_id` scoping) on every public read.
- Redis caching with explicit invalidation, Redis-backed rate limiting.
- BullMQ workers for imaging, notifications, trending/SOTD/search recompute, and purges.
- Prometheus metrics, pino structured logs, Sentry error tracking, health/readiness probes.
- Consistent error envelope everywhere:
  `{ success: false, error: { code, message, details? } }`.

---

## Architecture

```
Android App ──► Express API (stateless, N replicas) ──┬──► PostgreSQL (Prisma, pooled)
React Admin ──►                                       ├──► Redis (cache / rate-limit / BullMQ)
                                                      └──► Cloudinary (assets)

BullMQ workers (separate processes):
  • sticker.worker        Sharp 512×512 WebP → Cloudinary → DB; counters; search-match push
  • notification.worker   Batched FCM multicast + dead-token cleanup
  • maintenance.worker    Trending/SOTD/search ZSET rebuilds, 15-day SearchQuery purge
```

Request flow is `route → controller → service → Prisma`; no business logic lives in route
files. All heavy work (Sharp, Cloudinary, FCM) runs off the request path in workers.

---

## Tech stack

| Layer                      | Technology                                   |
| -------------------------- | -------------------------------------------- |
| Runtime                    | Node.js >= 20 (ESM), Express 5               |
| Database                   | PostgreSQL + Prisma 7 (`@prisma/adapter-pg`) |
| Cache / Queue / Rate-limit | Redis 7 (ioredis) + BullMQ                   |
| Assets                     | Cloudinary                                   |
| Imaging                    | Sharp                                        |
| Push                       | Firebase Admin SDK (FCM)                     |
| Validation / Security      | Zod, bcrypt, jsonwebtoken, multer            |
| Observability              | pino, prom-client (Prometheus), Sentry       |
| Tooling                    | Vitest, Supertest, ESLint, Prettier          |

---

## Prerequisites

- **Node.js >= 20 LTS**
- **PostgreSQL 16** and **Redis 7**

The quickest way to get the datastores is the bundled compose file:

```bash
docker compose up -d postgres redis
```

---

## Getting started

```bash
# 1. Install dependencies
npm ci

# 2. Configure the environment
cp .env.example .env
#    then edit .env (at minimum DATABASE_URL, REDIS_URL, JWT_SECRET, JWT_REFRESH_SECRET)

# 3. Start Postgres + Redis (if not already running)
docker compose up -d postgres redis

# 4. Generate the Prisma client and apply migrations
npm run db:generate
npm run db:migrate

# 5. Seed demo tenants/stickers
npm run db:seed

# 6. Provision an admin (one-time; admins are never created via HTTP)
npm run admin:create -- devroot 'your-strong-password'

# 7. Run the API (http://127.0.0.1:8080) and, in a second terminal, the worker
npm run dev
npm run worker
```

Open **http://127.0.0.1:8080/docs** for the interactive API reference and
**http://127.0.0.1:8080/healthz** / `/readyz` for probes.

> The dev server listens on **8080**. `localhost` may resolve to IPv6; prefer the literal
> `http://127.0.0.1:8080` when testing locally.

---

## Environment variables

Validated with Zod at boot — the process **fails fast** if required values are missing.
See [`.env.example`](./.env.example) for the full annotated list.

| Variable                                                 | Required | Description                                                      |
| -------------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| `NODE_ENV`                                               | no       | `development` \| `test` \| `production` (default `development`). |
| `PORT`                                                   | no       | HTTP port (default `8080`).                                      |
| `DATABASE_URL`                                           | **yes**  | PostgreSQL connection string.                                    |
| `REDIS_URL`                                              | **yes**  | Redis connection string.                                         |
| `JWT_SECRET`                                             | **yes**  | Access-token secret, >= 32 bytes.                                |
| `JWT_REFRESH_SECRET`                                     | **yes**  | Refresh-token secret, >= 32 bytes.                               |
| `BCRYPT_ROUNDS`                                          | no       | Password hashing cost (default `12`).                            |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET`     | prod     | Cloudinary credentials (empty = uploads fail).                   |
| `FIREBASE_PROJECT_ID` / `_CLIENT_EMAIL` / `_PRIVATE_KEY` | prod     | Firebase Admin credentials.                                      |
| `FCM_DRY_RUN`                                            | no       | `true` simulates FCM dispatch without network (dev/CI).          |
| `SENTRY_DSN`                                             | no       | Empty disables error reporting.                                  |
| `SENTRY_ENVIRONMENT` / `SENTRY_RELEASE`                  | no       | Sentry context tags.                                             |
| `SENTRY_TRACES_SAMPLE_RATE`                              | no       | Performance sample rate `0`–`1` (default `0`).                   |

---

## Scripts

| Script                                  | Purpose                                 |
| --------------------------------------- | --------------------------------------- |
| `npm run dev`                           | API with `--watch` (default port 8080). |
| `npm start`                             | API (no watch).                         |
| `npm run worker`                        | BullMQ worker process.                  |
| `npm test`                              | Run the Vitest suite once.              |
| `npm run test:watch`                    | Vitest in watch mode.                   |
| `npm run lint`                          | ESLint.                                 |
| `npm run format` / `format:check`       | Prettier write / check.                 |
| `npm run db:generate`                   | Generate the Prisma client.             |
| `npm run db:migrate`                    | Create/apply a dev migration.           |
| `npm run db:migrate:deploy`             | Apply committed migrations (CI/prod).   |
| `npm run db:seed`                       | Seed demo data.                         |
| `npm run admin:create -- <user> <pass>` | Provision an admin account.             |

---

## API documentation

- **Swagger UI:** `GET /docs` (loads the spec from a CDN; no extra dependency).
- **Raw OpenAPI 3.0.3 document:** `GET /openapi.yaml` (also committed as `openapi.yaml`).

Both are outside `/api`, so they are never rate-limited or blocked by tenant maintenance mode.

### Endpoint map

**Public (`/api`)**

| Method | Path                                      | Notes                                                             |
| ------ | ----------------------------------------- | ----------------------------------------------------------------- |
| `GET`  | `/api/stickers`                           | Feed (`sort_by=latest\|trending`, cursor, `limit<=50`, `search`). |
| `GET`  | `/api/stickers/daily`                     | Sticker of the Day.                                               |
| `GET`  | `/api/stickers/{id}`                      | Deep link (tenant-scoped, hidden excluded).                       |
| `POST` | `/api/stickers/{id}/download` \| `/share` | Engagement counters.                                              |
| `POST` | `/api/stickers/{id}/report`               | Content report (idempotent).                                      |
| `POST` | `/api/auth/device`                        | Device register + throttled activity + streaks.                   |
| `GET`  | `/api/auth/device`                        | Streak / last-active read.                                        |
| `POST` | `/api/search`                             | Log a normalized search.                                          |
| `GET`  | `/api/search/trending`                    | Trending keywords.                                                |
| `GET`  | `/api/search/suggest`                     | Autocomplete suggestions.                                         |
| `POST` | `/api/user/favorites/batch`               | Idempotent ADD/REMOVE batch.                                      |
| `GET`  | `/api/user/favorites`                     | Re-hydrate favorites (cursor).                                    |
| `GET`  | `/api/apps/{app_id}/version`              | Update policy (cached).                                           |
| `GET`  | `/api/apps/{app_id}/ads`                  | Ad unit config (cached).                                          |

**Admin (`/api/admin`, `Authorization: Bearer <token>`)**

| Method           | Path                                                           | Notes                                                |
| ---------------- | -------------------------------------------------------------- | ---------------------------------------------------- |
| `POST`           | `/api/admin/login`                                             | Login (sets refresh cookie), rate-limited + lockout. |
| `POST`           | `/api/admin/refresh` \| `/logout`, `GET /me`                   | Session lifecycle.                                   |
| `POST`           | `/api/admin/stickers`                                          | Upload (multipart) → `202` + `job_id`.               |
| `POST`           | `/api/admin/stickers/bulk`                                     | Bulk ZIP upload → `202` + `job_id`.                  |
| `PUT` / `DELETE` | `/api/admin/stickers/{id}`                                     | Update (metadata/image) or delete.                   |
| `POST`           | `/api/admin/stickers/{id}/hide` \| `/unhide`                   | Soft-delete / restore.                               |
| `GET`            | `/api/admin/jobs/{job_id}`                                     | Async job / bulk progress.                           |
| `GET`            | `/api/admin/reports`, `POST /reports/{id}/dismiss\|resolve`    | Moderation queue.                                    |
| `POST`           | `/api/admin/notifications/broadcast`                           | FCM campaign → `202` + `campaign_id`.                |
| `GET`            | `/api/admin/notifications/{campaign_id}`                       | Campaign status.                                     |
| `PUT`            | `/api/admin/apps/{app_id}/version` \| `/ads` \| `/maintenance` | Tenant config.                                       |
| `GET`            | `/api/admin/audit`                                             | Audit trail (filters, cursor).                       |

**Ops (outside `/api`)**

| Method | Path                     | Notes                      |
| ------ | ------------------------ | -------------------------- |
| `GET`  | `/healthz`               | Liveness.                  |
| `GET`  | `/readyz`                | Readiness (DB + Redis).    |
| `GET`  | `/metrics`               | Prometheus scrape target.  |
| `GET`  | `/openapi.yaml`, `/docs` | OpenAPI spec + Swagger UI. |

---

## Project structure

```
.
├── openapi.yaml            # OpenAPI 3.0.3 spec (served at /openapi.yaml)
├── prisma/
│   ├── schema.prisma       # Data model (context.md §3)
│   ├── migrations/         # Committed migrations
│   ├── seed.js             # Demo tenants/stickers/tags
│   └── create-admin.js     # One-time admin provisioning
├── src/
│   ├── app.js              # Express app assembly (health, metrics, docs, routers)
│   ├── server.js          # HTTP server bootstrap
│   ├── worker.js          # BullMQ worker bootstrap
│   ├── config/            # env (Zod), logger (pino), prisma, redis
│   ├── lib/               # errors, cache, metrics, sentry, audit, trending, openapi, ...
│   ├── middleware/        # validate, rateLimit, errorHandler, maintenance, admin auth
│   ├── modules/           # feature modules: route → controller → service
│   ├── queues/            # BullMQ queue definitions
│   └── workers/           # BullMQ worker processors
├── tests/                 # Vitest unit + integration suites
├── docs/observability.md  # Signals, alert thresholds, backup policy
├── Dockerfile             # Multi-stage build (API + worker share one image)
├── docker-compose.yml     # Postgres, Redis, optional api/worker (`--profile app`)
└── .github/workflows/ci.yml
```

---

## Testing & quality

```bash
npm run lint
npm test
npm run format:check
```

The suite (Vitest + Supertest) covers unit and integration behavior, including tenant
isolation, auth, rate limits, caching/invalidation, workers, moderation, audit, metrics,
and error tracking. Tests run against the same Postgres/Redis defined in `.env`.

---

## Background workers

Run at least one worker process alongside the API (scale by adding processes):

```bash
npm run worker
```

Queues: `sticker` (upload/replace/delete/counters/bulk), `notification` (FCM campaigns
and search-match pushes — batched at 500 with dead-token cleanup), and `maintenance`
(trending/SOTD/search ZSET recomputes + the 15-day `SearchQuery` purge). Worker jobs are
idempotent and use exponential backoff retries.

---

## Deployment

**Docker** — the multi-stage `Dockerfile` builds one image used by both the API and worker:

```bash
docker compose --profile app up -d --build
```

Migrations are applied separately before rollout (`npm run db:migrate:deploy`). The runtime
image is `node:22-bookworm-slim`, runs as the non-root `node` user, and listens on `8080`.

**CI** — `.github/workflows/ci.yml` provisions Postgres + Redis services, then runs
`prisma generate` → `migrate deploy` → `lint` → `test` on pushes to `main` and PRs.

**Observability** — scrape `/metrics` (Prometheus) and `/healthz` + `/readyz` (probes);
see [`docs/observability.md`](./docs/observability.md) for signals, alert thresholds, and
the backup policy. Sentry reporting is enabled by setting `SENTRY_DSN`.

---

## Contributing

- Read [`AGENTS.md`](./AGENTS.md) for conventions and [`context.md`](./context.md) for the spec.
- Pure JavaScript only; every endpoint validates input with Zod and is tenant-scoped.
- TDD: write failing tests first, then implement. Run `npm run lint` and `npm test` before
  considering a change complete. Update `CHANGELOG.md` and `project_state.md` per step.

---

## License

Proprietary. All rights reserved.
