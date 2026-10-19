import { listAuditLogs } from "./admin.audit.service.js";

/** GET /api/admin/audit — append-only audit trail (context.md §7.8). */
export async function getAuditLogs(req, res) {
  const { data, next_cursor } = await listAuditLogs({
    prisma: req.app.locals.prisma,
    app_id: req.query.app_id,
    action: req.query.action,
    admin_id: req.query.admin_id,
    cursor: req.query.cursor,
    limit: req.query.limit,
  });

  res.status(200).json({ success: true, data, next_cursor });
}
