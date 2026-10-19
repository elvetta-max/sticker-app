import { z } from "zod";
import { NotificationTarget } from "../../lib/notification.js";

/** Body for `POST /api/admin/notifications/broadcast` (context.md §4.11). */
export const broadcastSchema = z.object({
  app_id: z.uuid(),
  target_type: z.enum([NotificationTarget.ALL, NotificationTarget.INACTIVE]),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(500),
  data: z.record(z.string(), z.string()).optional(),
});

/** Params for `GET /api/admin/notifications/{campaign_id}`. */
export const campaignParamsSchema = z.object({
  campaign_id: z.uuid(),
});
