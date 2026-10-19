import { registerDevice, getDevice, DEVICE_SYNC_MESSAGE } from "./device.service.js";

/**
 * POST /api/auth/device — register/sync a device profile (context.md §4.1).
 */
export async function postDevice(req, res) {
  await registerDevice({
    prisma: req.app.locals.prisma,
    device_id: req.body.device_id,
    app_id: req.body.app_id,
    fcm_token: req.body.fcm_token,
  });

  res.status(200).json({ success: true, message: DEVICE_SYNC_MESSAGE });
}

/**
 * GET /api/auth/device — return `{ streak_count, last_active_date }` (context.md §4.15).
 */
export async function getDeviceHandler(req, res) {
  const data = await getDevice({
    prisma: req.app.locals.prisma,
    device_id: req.query.device_id,
    app_id: req.query.app_id,
  });

  res.status(200).json({ success: true, data });
}
