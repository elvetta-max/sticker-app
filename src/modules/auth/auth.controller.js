import { login, refresh, logout } from "./auth.service.js";
import { getRefreshCookie, setRefreshCookie, clearRefreshCookie } from "../../lib/cookies.js";

/**
 * Shape the token payload for the client. The refresh token is delivered only
 * as an httpOnly cookie and never appears in the JSON body.
 * @param {*} result
 */
function tokenResponse(result) {
  return {
    success: true,
    data: {
      access_token: result.access_token,
      token_type: result.token_type,
      expires_in: result.expires_in,
      admin: result.admin,
    },
  };
}

/**
 * POST /api/admin/login
 */
export async function postLogin(req, res) {
  const result = await login({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    username: req.body.username,
    password: req.body.password,
  });

  setRefreshCookie(res, result.refresh_token);
  res.status(200).json(tokenResponse(result));
}

/**
 * POST /api/admin/refresh — rotates the httpOnly refresh cookie.
 */
export async function postRefresh(req, res) {
  const result = await refresh({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    token: getRefreshCookie(req),
  });

  setRefreshCookie(res, result.refresh_token);
  res.status(200).json(tokenResponse(result));
}

/**
 * POST /api/admin/logout — revokes the refresh token and clears the cookie.
 */
export async function postLogout(req, res) {
  await logout({ redis: req.app.locals.redis, token: getRefreshCookie(req) });
  clearRefreshCookie(res);
  res.status(200).json({ success: true, message: "Logged out." });
}

/**
 * GET /api/admin/me — returns the authenticated admin (requireAdmin probe).
 */
export async function getMe(req, res) {
  res.status(200).json({ success: true, data: req.admin });
}
