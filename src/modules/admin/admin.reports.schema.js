import { z } from "zod";

/** Report lifecycle states (context.md §4.14). `resolve` → REVIEWED, `dismiss` → DISMISSED. */
export const REPORT_STATUSES = ["OPEN", "REVIEWED", "DISMISSED"];

/** Query for `GET /api/admin/reports` (context.md §4.14). */
export const reportsQuerySchema = z.object({
  app_id: z.uuid(),
  status: z.enum(REPORT_STATUSES).default("OPEN"),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/** Params for the triage endpoints. */
export const reportIdParamsSchema = z.object({
  id: z.uuid(),
});
