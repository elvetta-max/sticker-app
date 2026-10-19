# syntax=docker/dockerfile:1

# ---- build: install deps, generate the Prisma client ----
FROM node:22-bookworm AS build
WORKDIR /app

COPY package.json package-lock.json prisma.config.ts ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

# Drop dev-only tooling (vitest, eslint, prisma CLI) from the runtime dependency tree.
RUN npm prune --omit=dev

# ---- runtime: same image runs the API or the worker ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

# Prisma needs libssl at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY package.json package-lock.json prisma.config.ts openapi.yaml ./
COPY src ./src

USER node
EXPOSE 8080

# Override with `node src/worker.js` for the BullMQ worker process.
CMD ["node", "src/server.js"]
