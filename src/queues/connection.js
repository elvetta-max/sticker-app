import { env } from "../config/env.js";

/**
 * Build BullMQ/ioredis connection options from a Redis URL.
 * `maxRetriesPerRequest: null` is required by BullMQ.
 * @param {string} [url]
 * @returns {{ host: string, port: number, username?: string, password?: string, db?: number, maxRetriesPerRequest: null }}
 */
export function redisConnectionOptions(url = env.REDIS_URL) {
  const parsed = new URL(url);
  /** @type {any} */
  const options = {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    maxRetriesPerRequest: null,
  };
  if (parsed.username) options.username = decodeURIComponent(parsed.username);
  if (parsed.password) options.password = decodeURIComponent(parsed.password);
  if (parsed.pathname && parsed.pathname.length > 1) {
    options.db = Number(parsed.pathname.slice(1));
  }
  return options;
}
