import { describe, it, expect } from "vitest";
import { redisConnectionOptions } from "../../src/queues/connection.js";

describe("redisConnectionOptions", () => {
  it("parses host and port with a BullMQ-safe retry setting", () => {
    const options = redisConnectionOptions("redis://localhost:6379");
    expect(options).toMatchObject({
      host: "localhost",
      port: 6379,
      maxRetriesPerRequest: null,
    });
  });

  it("defaults the port and reads password + db", () => {
    const options = redisConnectionOptions("redis://:secret@redis.internal/3");
    expect(options.host).toBe("redis.internal");
    expect(options.port).toBe(6379);
    expect(options.password).toBe("secret");
    expect(options.db).toBe(3);
  });

  it("reads an explicit username", () => {
    const options = redisConnectionOptions("redis://user:pass@host:6380/0");
    expect(options.username).toBe("user");
    expect(options.password).toBe("pass");
    expect(options.port).toBe(6380);
  });
});
