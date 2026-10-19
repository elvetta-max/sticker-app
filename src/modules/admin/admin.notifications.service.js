import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors.js";
import { NotificationTarget, inactiveCutoff } from "../../lib/notification.js";
import { NotificationJob } from "../../queues/notification.queue.js";

/**
 * Resolve the campaign audience and enqueue the broadcast job (context.md §4.11).
 *
 * The audience is resolved here (not in the worker) so the response can report
 * `targeted_devices_count`; the resolved device ids travel with the job as a stable
 * snapshot. Devices must have a token and notifications enabled.
 *
 * @param {{
 *   prisma: any,
 *   queue: { add: Function },
 *   app_id: string,
 *   target_type: "ALL"|"INACTIVE",
 *   title: string,
 *   body: string,
 *   data?: object,
 * }} args
 * @returns {Promise<{ campaign_id: string, targeted_devices_count: number }>}
 */
export async function createBroadcast({ prisma, queue, app_id, target_type, title, body, data }) {
  const app = await prisma.app.findUnique({ where: { id: app_id }, select: { id: true } });
  if (!app) {
    throw AppError.notFound("App not found.");
  }

  const where = { app_id, fcm_token: { not: null }, notifications_enabled: true };
  if (target_type === NotificationTarget.INACTIVE) {
    where.last_active_date = { lte: inactiveCutoff() };
  }

  const devices = await prisma.deviceProfile.findMany({ where, select: { device_id: true } });
  const device_ids = devices.map((device) => device.device_id);

  const campaign_id = randomUUID();
  await queue.add(
    NotificationJob.BROADCAST,
    { campaign_id, app_id, target_type, title, body, data: data ?? null, device_ids },
    { jobId: campaign_id },
  );

  return { campaign_id, targeted_devices_count: device_ids.length };
}

/**
 * Read a campaign's current state by its id (which is also the BullMQ job id).
 * @param {{ queue: { getJob: Function }, campaign_id: string }} args
 */
export async function getCampaign({ queue, campaign_id }) {
  const job = await queue.getJob(campaign_id);
  if (!job) {
    throw AppError.notFound("Campaign not found.");
  }

  const status = await job.getState();
  return {
    campaign_id,
    status,
    result: job.returnvalue ?? null,
    error: job.failedReason ?? null,
  };
}
