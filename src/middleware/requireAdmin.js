import { AppError } from "../lib/errors.js";
import { verifyAccessToken } from "../lib/tokens.js";

/**
 * JWT Bearer guard for `/api/admin/*` routes (context.md §4.7).
 * On success attaches `{ id, username }` to `req.admin`.
 */
export function requireAdmin(req, _res, next) {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    return next(AppError.unauthorized("Missing or malformed Authorization header."));
  }

  try {
    const payload = verifyAccessToken(token);
    req.admin = { id: payload.sub, username: payload.username };
    return next();
  } catch {
    return next(AppError.unauthorized("Invalid or expired access token."));
  }
}

export default requireAdmin;
