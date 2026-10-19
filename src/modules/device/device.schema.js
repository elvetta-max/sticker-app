import { z } from "zod";

/**
 * Body for `POST /api/auth/device` (context.md §4.1).
 * `fcm_token` is optional so a device can register before FCM issues a token;
 * when omitted the stored token is left untouched.
 */
export const registerDeviceSchema = z.object({
  device_id: z.string().trim().min(1).max(128),
  fcm_token: z.string().max(512).optional(),
  app_id: z.uuid(),
});

/** Query for `GET /api/auth/device` (context.md §4.15). */
export const deviceQuerySchema = z.object({
  device_id: z.string().trim().min(1).max(128),
  app_id: z.uuid(),
});
