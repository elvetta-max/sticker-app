import { decodeCursor, encodeCursor } from "../../lib/cursor.js";

/**
 * Map an AuditLog row to the admin DTO (context.md §7.8).
 * @param {object} row
 */
export function toAuditDto(row) {
  return {
    id: row.id,
    admin_id: row.admin_id,
    admin_username: row.admin_username,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    app_id: row.app_id,
    metadata: row.metadata,
    created_at: row.created_at,
  };
}

/**
 * List the append-only audit trail, newest-first and cursor-paginated.
 * Filters combine with AND; all are optional so the dashboard can slice by tenant,
 * action, or admin.
 *
 * @param {{ prisma: any, app_id?: string, action?: string, admin_id?: string,
 *   cursor?: string, limit: number }} args
 */
export async function listAuditLogs({ prisma, app_id, action, admin_id, cursor, limit }) {
  const conditions = [];
  if (app_id) conditions.push({ app_id });
  if (action) conditions.push({ action });
  if (admin_id) conditions.push({ admin_id });

  if (cursor) {
    const { createdAt, id } = decodeCursor(cursor);
    conditions.push({
      OR: [
        { created_at: { lt: createdAt } },
        { AND: [{ created_at: createdAt }, { id: { lt: id } }] },
      ],
    });
  }

  const rows = await prisma.auditLog.findMany({
    where: conditions.length > 0 ? { AND: conditions } : {},
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const next_cursor =
    hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

  return { data: page.map(toAuditDto), next_cursor };
}
