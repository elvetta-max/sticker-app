import { logger as defaultLogger } from "../config/logger.js";

/**
 * Append-only admin audit trail (context.md §7.8): who did what, when, to which
 * target. Recording is best effort — an audit failure must never fail the admin
 * mutation that already succeeded.
 */

/** Every audited admin mutation. */
export const AuditAction = Object.freeze({
  STICKER_CREATE: "sticker.create",
  STICKER_UPDATE: "sticker.update",
  STICKER_REPLACE: "sticker.replace",
  STICKER_DELETE: "sticker.delete",
  STICKER_HIDE: "sticker.hide",
  STICKER_UNHIDE: "sticker.unhide",
  STICKER_BULK: "sticker.bulk",
  APP_VERSION_UPDATE: "app.version.update",
  APP_ADS_UPDATE: "app.ads.update",
  APP_MAINTENANCE_UPDATE: "app.maintenance.update",
  REPORT_DISMISS: "report.dismiss",
  REPORT_RESOLVE: "report.resolve",
  NOTIFICATION_BROADCAST: "notification.broadcast",
});

/** What an audit row points at. */
export const AuditTarget = Object.freeze({
  STICKER: "sticker",
  JOB: "job",
  APP: "app",
  REPORT: "report",
  NOTIFICATION: "notification",
});

/**
 * Append one audit row.
 *
 * @param {{
 *   prisma: any,
 *   actor?: { id?: string, username?: string } | null,
 *   action: string,
 *   target_type: string,
 *   target_id?: string | null,
 *   app_id?: string | null,
 *   metadata?: object | null,
 *   logger?: { error: Function },
 * }} args
 * @returns {Promise<object | null>} the created row, or null when recording failed
 */
export async function recordAudit({
  prisma,
  actor,
  action,
  target_type,
  target_id,
  app_id,
  metadata,
  logger = defaultLogger,
}) {
  try {
    return await prisma.auditLog.create({
      data: {
        admin_id: actor?.id ?? null,
        admin_username: actor?.username ?? null,
        action,
        target_type,
        target_id: target_id ?? null,
        app_id: app_id ?? null,
        ...(metadata != null ? { metadata } : {}),
      },
    });
  } catch (err) {
    logger?.error?.({ err, action, target_type, target_id, app_id }, "audit log write failed");
    return null;
  }
}

export default recordAudit;
