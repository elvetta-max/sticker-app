import { AppError } from "../../lib/errors.js";

/** Standard response message for a successful device sync (context.md §4.1). */
export const DEVICE_SYNC_MESSAGE = "Device profile and FCM token synchronized successfully.";

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC calendar day as `YYYY-MM-DD` (the app's canonical timezone is UTC, §5.3). */
function utcDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

/**
 * Register/synchronize a device profile with daily write-throttling and streak
 * tracking (context.md §4.1 + §4.15).
 *
 * - Unknown tenant → silent no-op (no write, no error; §4.1 "silently reject unknown tenants").
 * - New device → create with `streak_count = 1`, `last_streak_date = today`.
 * - Existing device, same day, same token → **zero writes** (the daily throttle).
 * - Same day but token changed → update only the token.
 * - New day → refresh `last_active_date`; `streak_count` +1 if the previous streak day was
 *   yesterday, otherwise reset to 1; `last_streak_date = today`.
 *
 * @param {{ prisma: any, device_id: string, app_id: string, fcm_token?: string, now?: Date }} args
 */
export async function registerDevice({ prisma, device_id, app_id, fcm_token, now = new Date() }) {
  const app = await prisma.app.findUnique({ where: { id: app_id }, select: { id: true } });
  if (!app) {
    return;
  }

  const existing = await prisma.deviceProfile.findUnique({ where: { device_id } });

  if (!existing) {
    await prisma.deviceProfile.create({
      data: {
        device_id,
        app_id,
        fcm_token: fcm_token ?? null,
        last_active_date: now,
        streak_count: 1,
        last_streak_date: now,
      },
    });
    return;
  }

  const fcmChanged = fcm_token !== undefined && existing.fcm_token !== fcm_token;
  const isNewDay = utcDay(existing.last_active_date) !== utcDay(now);

  if (!fcmChanged && !isNewDay) {
    return;
  }

  const data = {};
  if (fcmChanged) {
    data.fcm_token = fcm_token;
  }
  if (isNewDay) {
    data.last_active_date = now;
    data.last_streak_date = now;
    const continued =
      existing.last_streak_date != null &&
      utcDay(existing.last_streak_date) === utcDay(new Date(now.getTime() - DAY_MS));
    data.streak_count = continued ? existing.streak_count + 1 : 1;
  }

  await prisma.deviceProfile.update({ where: { device_id }, data });
}

/**
 * Read a device's streak state (context.md §4.15), scoped to its tenant.
 * @param {{ prisma: any, device_id: string, app_id: string }} args
 */
export async function getDevice({ prisma, device_id, app_id }) {
  const profile = await prisma.deviceProfile.findFirst({
    where: { device_id, app_id },
    select: { streak_count: true, last_active_date: true },
  });

  if (!profile) {
    throw AppError.notFound("Device not found.");
  }

  return profile;
}
