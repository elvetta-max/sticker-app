import { Router } from "express";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { reportsQuerySchema, reportIdParamsSchema } from "./admin.reports.schema.js";
import { getReports, dismissReport, resolveReport } from "./admin.reports.controller.js";

export const adminReportsRouter = Router();

const adminMutationLimit = rateLimit({
  windowSeconds: 60,
  max: 120,
  keyPrefix: "rl:admin-mutation",
  keyGenerator: (req) => req.admin?.id ?? req.ip ?? "unknown",
});

adminReportsRouter.get("/", requireAdmin, validate({ query: reportsQuerySchema }), getReports);

adminReportsRouter.post(
  "/:id/dismiss",
  requireAdmin,
  adminMutationLimit,
  validate({ params: reportIdParamsSchema }),
  dismissReport,
);

adminReportsRouter.post(
  "/:id/resolve",
  requireAdmin,
  adminMutationLimit,
  validate({ params: reportIdParamsSchema }),
  resolveReport,
);

export default adminReportsRouter;
