import { createBroadcast, getCampaign } from "./admin.notifications.service.js";
import { getNotificationQueue } from "../../queues/notification.queue.js";
import { AuditAction, AuditTarget, recordAudit } from "../../lib/audit.js";

/**
 * POST /api/admin/notifications/broadcast — enqueue an async FCM campaign and
 * return 202 with the campaign id + resolved audience size (context.md §4.11).
 */
export async function postBroadcast(req, res) {
  const queue = req.app.locals.notificationQueue ?? getNotificationQueue();
  const { campaign_id, targeted_devices_count } = await createBroadcast({
    prisma: req.app.locals.prisma,
    queue,
    app_id: req.body.app_id,
    target_type: req.body.target_type,
    title: req.body.title,
    body: req.body.body,
    data: req.body.data,
  });

  await recordAudit({
    prisma: req.app.locals.prisma,
    actor: req.admin,
    action: AuditAction.NOTIFICATION_BROADCAST,
    target_type: AuditTarget.NOTIFICATION,
    target_id: campaign_id,
    app_id: req.body.app_id,
  });

  res.status(202).json({ success: true, campaign_id, targeted_devices_count });
}

/**
 * GET /api/admin/notifications/{campaign_id} — campaign status/result (context.md §4.11).
 */
export async function getCampaignHandler(req, res) {
  const queue = req.app.locals.notificationQueue ?? getNotificationQueue();
  const data = await getCampaign({ queue, campaign_id: req.params.campaign_id });
  res.status(200).json({ success: true, data });
}
