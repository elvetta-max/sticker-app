import { env } from "../config/env.js";

export const REFRESH_COOKIE_NAME = "refresh_token";
const REFRESH_COOKIE_PATH = "/api/admin";
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Parse the Cookie header into a plain object.
 * Avoids adding a cookie-parser dependency for a single cookie.
 * @param {string | undefined} header
 * @returns {Record<string, string>}
 */
export function parseCookies(header = "") {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/**
 * @param {import("express").Request} req
 * @returns {string | undefined}
 */
export function getRefreshCookie(req) {
  return parseCookies(req.headers.cookie)[REFRESH_COOKIE_NAME];
}

/**
 * Set the httpOnly refresh-token cookie.
 * @param {import("express").Response} res
 * @param {string} token
 */
export function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: env.NODE_ENV === "production",
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  });
}

/** @param {import("express").Response} res */
export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    sameSite: "strict",
    secure: env.NODE_ENV === "production",
    path: REFRESH_COOKIE_PATH,
  });
}
