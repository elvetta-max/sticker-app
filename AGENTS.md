# AGENTS.md — Project Conventions (api-stiker)

This file is binding for all agents working in this repository. `context.md` is the
product/technical spec and the single source of truth; where they differ, `context.md` wins.

## Stack discipline

- **Pure JavaScript only.** No TypeScript, no `.ts` files, no type build step. Use JSDoc.
- **ES Modules.** `"type": "module"`, Node >= 20 LTS.
- Allowed dependencies only: express, prisma/@prisma/client, ioredis, bullmq, sharp,
  cloudinary, zod, bcrypt, jsonwebtoken, helmet, cors, express-rate-limit, pino,
  pino-http, multer, dotenv. Add nothing else without explicit approval.
- Dev tooling: vitest, supertest, eslint, prettier.

## Architecture rules

- Route -> controller -> service -> Prisma. **No business logic in route files.**
- Every endpoint validates params, query, and body with Zod.
- Every public query is scoped by `app_id` and filters `is_hidden = false`.
- All list endpoints are cursor-paginated; `limit` is capped (feed max 50).
- Heavy work (Sharp, Cloudinary, FCM) runs in BullMQ workers, never on the request path.
- Consistent error envelope: `{ success: false, error: { code, message, details? } }`.

## Workflow (TDD, step by step)

1. The `tdd-test` agent writes failing tests first, then the implementer makes them pass.
2. Run `npm run lint` and `npm test` before declaring a step complete.
3. Update `CHANGELOG.md` and `project_state.md` at the end of each step.
4. Do not commit unless explicitly asked.

## Sandbox note

This repo is developed inside an opencode Flatpak sandbox that has no system Node.
A Node v24 LTS binary is installed at `~/.local/node`. Prefix commands with:
`export PATH="$HOME/.local/node/bin:$PATH"`

**Port 3000 is a black hole in this environment** — a stale listener is bound to
`::0.0.0.0:3000` outside our PID namespace. It accepts TCP connections but never
responds, so browsers hang forever. Do **not** use port 3000; the dev server defaults
to **8080** (`PORT=8080` in `.env`). Access it as `http://127.0.0.1:8080` (use the
literal IP, not `localhost`, to avoid IPv6 resolution). Verified-working ports: 8080, 3200.
