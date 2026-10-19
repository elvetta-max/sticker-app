import { getRedis } from "../config/redis.js";
import { ErrorCodes, errorEnvelope } from "../lib/errors.js";

const defaultKeyGenerator = (req) => req.ip ?? "unknown";

/**
 * Redis-backed fixed-window rate limiter (skeleton).
 *
 * Uses INCR + EXPIRE per window. Fails open by default so a Redis outage does not
 * take the API down. Per-surface limits from context.md §6.5 are layered on top of
 * this in later steps.
 *
 * @param {{
 *   windowSeconds?: number,
 *   max?: number,
 *   keyPrefix?: string,
 *   keyGenerator?: (req: import("express").Request) => string,
 *   failOpen?: boolean,
 * }} [options]
 */
export function rateLimit({
  windowSeconds = 60,
  max = 300,
  keyPrefix = "ratelimit",
  keyGenerator = defaultKeyGenerator,
  failOpen = true,
} = {}) {
  return async function rateLimitMiddleware(req, res, next) {
    const redis = req.app.locals.redis ?? getRedis();
    const key = `${keyPrefix}:${keyGenerator(req)}`;

    try {
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, windowSeconds);
      }

      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - count)));

      if (count > max) {
        res.setHeader("Retry-After", String(windowSeconds));
        return res
          .status(429)
          .json(errorEnvelope(ErrorCodes.RATE_LIMITED, "Too many requests. Please slow down."));
      }

      return next();
    } catch (err) {
      req.log?.warn?.({ err }, "rate limit store error");
      if (failOpen) {
        return next();
      }
      return res
        .status(503)
        .json(errorEnvelope(ErrorCodes.NOT_READY, "Rate limiter temporarily unavailable."));
    }
  };
}

export default rateLimit;
