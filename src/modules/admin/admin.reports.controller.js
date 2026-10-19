import { listReports, triageReport } from "./admin.reports.service.js";
import { AuditAction, AuditTarget, recordAudit } from "../../lib/audit.js";

/** GET /api/admin/reports — moderation review queue (context.md §4.14). */
export async function getReports(req, res) {
  const { data, next_cursor } = await listReports({
    prisma: req.app.locals.prisma,
    app_id: req.query.app_id,
    status: req.query.status,
    cursor: req.query.cursor,
    limit: req.query.limit,
  });

  res.status(200).json({ success: true, data, next_cursor });
}

/** Shared triage handler for dismiss/resolve (context.md §4.14). */
async function triage(req, res, status, action) {
  const data = await triageReport({
    prisma: req.app.locals.prisma,
    id: req.params.id,
    status,
  });

  await recordAudit({
    prisma: req.app.locals.prisma,
    actor: req.admin,
    action,
    target_type: AuditTarget.REPORT,
    target_id: req.params.id,
    app_id: data.app_id,
  });

  res.status(200).json({ success: true, data });
}

/** POST /api/admin/reports/{id}/dismiss (context.md §4.14). */
export function dismissReport(req, res) {
  return triage(req, res, "DISMISSED", AuditAction.REPORT_DISMISS);
}

/** POST /api/admin/reports/{id}/resolve (context.md §4.14). */
export function resolveReport(req, res) {
  return triage(req, res, "REVIEWED", AuditAction.REPORT_RESOLVE);
}
