import { Router } from "express";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { validate } from "../../middleware/validate.js";
import { jobParamsSchema } from "./admin.jobs.schema.js";
import { getJob } from "./admin.jobs.controller.js";

export const adminJobsRouter = Router();

adminJobsRouter.get("/:job_id", requireAdmin, validate({ params: jobParamsSchema }), getJob);

export default adminJobsRouter;
