import { z } from "zod";

/** Params for all `/api/apps/{app_id}/*` routes. */
export const appIdParamsSchema = z.object({
  app_id: z.uuid(),
});

/**
 * Query for `GET /api/apps/{app_id}/version` (context.md §4.12). `current_version`
 * is the client's installed version; when omitted it is treated as `0` (unknown →
 * assume outdated) so a forced update is still surfaced.
 */
export const appVersionQuerySchema = z.object({
  current_version: z.coerce.number().int().min(0).optional(),
});
