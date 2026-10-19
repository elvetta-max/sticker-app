import jwt from "jsonwebtoken";
import { createHash, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

/** Access-token lifetime: 15 minutes (context.md §4.7). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/** Refresh-token lifetime: 7 days (context.md §4.7). */
export const REFRESH_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Sign a short-lived HS256 access token for an admin.
 * @param {{ id: string, username: string }} admin
 * @returns {string}
 */
export function signAccessToken(admin) {
  return jwt.sign({ sub: admin.id, username: admin.username }, env.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });
}

/**
 * Verify an access token. Throws (jsonwebtoken error) when invalid/expired.
 * @param {string} token
 * @returns {{ sub: string, username: string }}
 */
export function verifyAccessToken(token) {
  return /** @type {any} */ (jwt.verify(token, env.JWT_SECRET, { algorithms: ["HS256"] }));
}

/**
 * Generate an opaque refresh token plus the hash persisted in Redis.
 * The raw token is only ever held by the client (httpOnly cookie).
 * @returns {{ token: string, hash: string }}
 */
export function createRefreshToken() {
  const token = randomBytes(48).toString("base64url");
  return { token, hash: hashRefreshToken(token) };
}

/**
 * SHA-256 hash of a refresh token. Only the hash is stored server-side.
 * @param {string} token
 * @returns {string}
 */
export function hashRefreshToken(token) {
  return createHash("sha256").update(token).digest("hex");
}
