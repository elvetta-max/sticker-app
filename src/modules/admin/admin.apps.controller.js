import { setAppVersion, setAppAds, setAppMaintenance } from "./admin.apps.service.js";
import { AuditAction, AuditTarget, recordAudit } from "../../lib/audit.js";

/** PUT /api/admin/apps/{app_id}/version (context.md §4.12). */
export async function putAppVersion(req, res) {
  const data = await setAppVersion({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    app_id: req.params.app_id,
    target_version: req.body.target_version,
    force_update: req.body.force_update,
  });

  await recordAudit({
    prisma: req.app.locals.prisma,
    actor: req.admin,
    action: AuditAction.APP_VERSION_UPDATE,
    target_type: AuditTarget.APP,
    target_id: req.params.app_id,
    app_id: req.params.app_id,
  });

  res.status(200).json({ success: true, data });
}

/** PUT /api/admin/apps/{app_id}/ads (context.md §4.13). */
export async function putAppAds(req, res) {
  const data = await setAppAds({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    app_id: req.params.app_id,
    body: req.body,
  });

  await recordAudit({
    prisma: req.app.locals.prisma,
    actor: req.admin,
    action: AuditAction.APP_ADS_UPDATE,
    target_type: AuditTarget.APP,
    target_id: req.params.app_id,
    app_id: req.params.app_id,
  });

  res.status(200).json({ success: true, data });
}

/** PUT /api/admin/apps/{app_id}/maintenance (context.md §4.18). */
export async function putAppMaintenance(req, res) {
  const data = await setAppMaintenance({
    prisma: req.app.locals.prisma,
    redis: req.app.locals.redis,
    app_id: req.params.app_id,
    maintenance_mode: req.body.maintenance_mode,
  });

  await recordAudit({
    prisma: req.app.locals.prisma,
    actor: req.admin,
    action: AuditAction.APP_MAINTENANCE_UPDATE,
    target_type: AuditTarget.APP,
    target_id: req.params.app_id,
    app_id: req.params.app_id,
  });

  res.status(200).json({ success: true, data });
}
