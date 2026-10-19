import { ErrorCodes, errorEnvelope } from "../lib/errors.js";
import { MAINTENANCE_MESSAGE, readMaintenanceFlag } from "../lib/maintenance.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION_PATH_RE = /^\/apps\/[^/]+\/version\/?$/;
const APP_PATH_RE = /^\/apps\/([^/]+)/;
const STICKER_PATH_RE = /^\/stickers\/([^/]+)/;

/**
 * Routes exempt from the maintenance gate (context.md §4.18): the Android client must
 * still receive version/maintenance info and keep its FCM token fresh. Admin routes are
 * always exempt. Only `POST /api/auth/device` is exempt — `GET` is gated like everything else.
 *
 * @param {import("express").Request} req
 */
export function isMaintenanceExempt(req) {
  const path = req.path;
  if (path === "/admin" || path.startsWith("/admin/")) return true;
  if (req.method === "POST" && path.replace(/\/$/, "") === "/auth/device") return true;
  if (req.method === "GET" && VERSION_PATH_RE.test(path)) return true;
  return false;
}

function firstUuid(...values) {
  for (const value of values) {
    if (typeof value === "string" && UUID_RE.test(value)) return value;
  }
  return null;
}

/**
 * Resolve the tenant a public request belongs to, cheaply: query/body first, then the
 * `/apps/{app_id}` path. Only the report endpoint (whose body carries no `app_id`) needs the
 * sticker-id fallback, so the DB is touched at most once for that one low-frequency route.
 *
 * @param {{ req: import("express").Request, prisma: any }} args
 * @returns {Promise<string | null>}
 */
export async function resolveMaintenanceAppId({ req, prisma }) {
  const direct = firstUuid(req.query?.app_id, req.body?.app_id, APP_PATH_RE.exec(req.path)?.[1]);
  if (direct) return direct;

  const stickerId = firstUuid(STICKER_PATH_RE.exec(req.path)?.[1]);
  if (stickerId && prisma) {
    const image = await prisma.image.findUnique({
      where: { id: stickerId },
      select: { app_id: true },
    });
    return image?.app_id ?? null;
  }
  return null;
}

/**
 * Public maintenance guard (context.md §4.18), mounted on `/api/*` before the routers.
 * When a tenant's flag is on, every public endpoint returns 503 except the exemptions.
 * Requests whose tenant cannot be resolved fall through to the routers' own 400/404.
 */
export async function maintenanceGuard(req, res, next) {
  try {
    if (isMaintenanceExempt(req)) return next();

    const prisma = req.app.locals.prisma;
    const appId = await resolveMaintenanceAppId({ req, prisma });
    if (!appId) return next();

    const on = await readMaintenanceFlag({ prisma, redis: req.app.locals.redis, appId });
    if (on) {
      return res.status(503).json(errorEnvelope(ErrorCodes.MAINTENANCE_MODE, MAINTENANCE_MESSAGE));
    }
    return next();
  } catch (err) {
    return next(err);
  }
}
