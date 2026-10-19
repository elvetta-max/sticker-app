import { Redis } from "ioredis";
import { env } from "./env.js";

let client = null;

/**
 * Lazily create the shared Redis client.
 * `lazyConnect` defers connecting until the first command; bounded retries and a
 * connect timeout keep readiness checks fast-failing instead of hanging.
 * @returns {Redis}
 */
export function getRedis() {
  if (!client) {
    client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (times) => (times > 3 ? null : Math.min(times * 200, 1000)),
    });
  }
  return client;
}

export async function disconnectRedis() {
  if (!client) return;
  const conn = client;
  client = null;
  try {
    if (conn.status === "ready") {
      await conn.quit();
    } else {
      // Never connected (e.g. lazy connect, Redis down) — force close quietly.
      conn.disconnect();
    }
  } catch {
    conn.disconnect();
  }
}
