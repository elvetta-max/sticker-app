import { Router } from "express";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { appIdParamsSchema } from "../apps/app.schema.js";
import {
  updateAppVersionSchema,
  updateAppAdsSchema,
  updateAppMaintenanceSchema,
} from "./admin.apps.schema.js";
import { putAppVersion, putAppAds, putAppMaintenance } from "./admin.apps.controller.js";

export const adminAppsRouter = Router();

const adminMutationLimit = rateLimit({
  windowSeconds: 60,
  max: 120,
  keyPrefix: "rl:admin-mutation",
  keyGenerator: (req) => req.admin?.id ?? req.ip ?? "unknown",
});

adminAppsRouter.put(
  "/:app_id/version",
  requireAdmin,
  adminMutationLimit,
  validate({ params: appIdParamsSchema, body: updateAppVersionSchema }),
  putAppVersion,
);

adminAppsRouter.put(
  "/:app_id/ads",
  requireAdmin,
  adminMutationLimit,
  validate({ params: appIdParamsSchema, body: updateAppAdsSchema }),
  putAppAds,
);

adminAppsRouter.put(
  "/:app_id/maintenance",
  requireAdmin,
  adminMutationLimit,
  validate({ params: appIdParamsSchema, body: updateAppMaintenanceSchema }),
  putAppMaintenance,
);

export default adminAppsRouter;
