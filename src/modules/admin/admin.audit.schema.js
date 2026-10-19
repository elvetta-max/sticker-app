import { z } from "zod";

/** Query for `GET /api/admin/audit` (context.md §7.8). */
export const auditQuerySchema = z.object({
  app_id: z.uuid().optional(),
  action: z.string().trim().min(1).max(64).optional(),
  admin_id: z.string().trim().min(1).max(64).optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
