import { z } from "zod";

/** Params for `GET /api/admin/jobs/{job_id}` (BullMQ ids are opaque strings). */
export const jobParamsSchema = z.object({
  job_id: z.string().min(1).max(64),
});
