// Runs before every test file. Provides safe defaults so config/env.js can be
// imported without a real .env. Values already present in process.env win,
// and dotenv does not override existing variables.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.PORT = process.env.PORT || "3000";
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://postgres:postgres@localhost:5432/api_stiker?schema=public";
process.env.REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-jwt-secret-value-that-is-at-least-32-bytes";
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || "test-jwt-refresh-secret-at-least-32-bytes";
