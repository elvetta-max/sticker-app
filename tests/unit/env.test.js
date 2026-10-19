import { describe, it, expect } from "vitest";
import { loadEnv } from "../../src/config/env.js";

const validEnv = {
  NODE_ENV: "test",
  PORT: "3000",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
  JWT_SECRET: "x".repeat(32),
  JWT_REFRESH_SECRET: "y".repeat(32),
};

describe("loadEnv", () => {
  it("parses a valid environment with coercion and defaults", () => {
    const env = loadEnv(validEnv);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe("test");
    expect(env.CLOUDINARY_CLOUD_NAME).toBe("");
  });

  it("throws when a required variable is missing", () => {
    const incomplete = { ...validEnv };
    delete incomplete.JWT_SECRET;
    expect(() => loadEnv(incomplete)).toThrow(/JWT_SECRET/);
  });

  it("throws when JWT_SECRET is too short", () => {
    expect(() => loadEnv({ ...validEnv, JWT_SECRET: "short" })).toThrow(/JWT_SECRET/);
  });

  it("throws when PORT is not a number", () => {
    expect(() => loadEnv({ ...validEnv, PORT: "not-a-port" })).toThrow(/PORT/);
  });
});
