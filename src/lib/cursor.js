import { AppError } from "./errors.js";

/**
 * Encode a keyset cursor as an opaque base64url token.
 * @param {{ createdAt: Date|string, id: string }} payload
 * @returns {string}
 */
export function encodeCursor({ createdAt, id }) {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : String(createdAt);
  return Buffer.from(JSON.stringify({ createdAt: iso, id }), "utf8").toString("base64url");
}

/**
 * Decode a keyset cursor. Throws a 400 AppError on malformed input.
 * @param {string} cursor
 * @returns {{ createdAt: Date, id: string }}
 */
export function decodeCursor(cursor) {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const id = decoded?.id;
    const createdAt = new Date(decoded?.createdAt);
    if (typeof id !== "string" || id.length === 0 || Number.isNaN(createdAt.getTime())) {
      throw new Error("invalid cursor payload");
    }
    return { createdAt, id };
  } catch {
    throw AppError.validation("Invalid cursor.");
  }
}

/**
 * Encode a trending (score, id) keyset cursor. Pagination runs against a stable
 * Redis ZSET snapshot (context.md §4.2).
 * @param {{ score: number, id: string }} payload
 * @returns {string}
 */
export function encodeScoreCursor({ score, id }) {
  return Buffer.from(JSON.stringify({ score, id }), "utf8").toString("base64url");
}

/**
 * Decode a trending keyset cursor. Throws a 400 AppError on malformed input.
 * @param {string} cursor
 * @returns {{ score: number, id: string }}
 */
export function decodeScoreCursor(cursor) {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    const id = decoded?.id;
    const score = Number(decoded?.score);
    if (typeof id !== "string" || id.length === 0 || !Number.isFinite(score)) {
      throw new Error("invalid score cursor payload");
    }
    return { score, id };
  } catch {
    throw AppError.validation("Invalid cursor.");
  }
}
