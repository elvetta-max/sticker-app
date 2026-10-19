import { AppError } from "../../lib/errors.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";

/**
 * Map a Report row (with `image`) to the admin review-queue DTO (context.md §4.14).
 * @param {object} report
 */
export function toReportDto(report) {
  return {
    id: report.id,
    app_id: report.app_id,
    device_id: report.device_id,
    image_id: report.image_id,
    reason: report.reason,
    status: report.status,
    created_at: report.created_at,
    image: report.image
      ? {
          id: report.image.id,
          app_id: report.image.app_id,
          image_url: report.image.image_url,
          is_hidden: report.image.is_hidden,
          is_premium: report.image.is_premium,
        }
      : null,
  };
}

/**
 * List a tenant's reports for the moderation queue, newest-first and cursor-paginated
 * (context.md §4.14). Scoped to a single tenant — cross-tenant reports are never returned.
 *
 * @param {{ prisma: any, app_id: string, status: string, cursor?: string, limit: number }} args
 */
export async function listReports({ prisma, app_id, status, cursor, limit }) {
  const app = await prisma.app.findUnique({ where: { id: app_id }, select: { id: true } });
  if (!app) {
    throw AppError.notFound("App not found.");
  }

  const conditions = [{ app_id }, { status }];
  if (cursor) {
    const { createdAt, id } = decodeCursor(cursor);
    conditions.push({
      OR: [
        { created_at: { lt: createdAt } },
        { AND: [{ created_at: createdAt }, { id: { lt: id } }] },
      ],
    });
  }

  const rows = await prisma.report.findMany({
    where: { AND: conditions },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: {
      image: {
        select: {
          id: true,
          app_id: true,
          image_url: true,
          is_hidden: true,
          is_premium: true,
        },
      },
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const next_cursor =
    hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

  return { data: page.map(toReportDto), next_cursor };
}

/**
 * Triage a single report (context.md §4.14).
 * @param {{ prisma: any, id: string, status: "REVIEWED"|"DISMISSED" }} args
 */
export async function triageReport({ prisma, id, status }) {
  const existing = await prisma.report.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    throw AppError.notFound("Report not found.");
  }

  return prisma.report.update({
    where: { id },
    data: { status },
    select: { id: true, app_id: true, image_id: true, status: true },
  });
}
