import { z } from "zod";

/** Body for `POST /api/admin/login`. */
export const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(128),
});
