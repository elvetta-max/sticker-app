import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "node prisma/seed.js",
  },
  datasource: {
    // Use process.env (not the throwing `env()` helper) so `prisma generate`
    // works in environments where DATABASE_URL may be absent.
    url: process.env.DATABASE_URL ?? "",
  },
});
