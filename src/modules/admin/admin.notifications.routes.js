import { Router } from "express";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import { broadcastSchema, campaignParamsSchema } from "./admin.notifications.schema.js";
import { postBroadcast, getCampaignHandler } from "./admin.notifications.controller.js";

export const adminNotificationsRouter = Router();

const adminMutationLimit = rateLimit({
  windowSeconds: 60,
  max: 120,
  keyPrefix: "rl:admin-mutation",
  keyGenerator: (req) => req.admin?.id ?? req.ip ?? "unknown",
});

adminNotificationsRouter.post(
  "/broadcast",
  requireAdmin,
  adminMutationLimit,
  validate({ body: broadcastSchema }),
  postBroadcast,
);

adminNotificationsRouter.get(
  "/:campaign_id",
  requireAdmin,
  validate({ params: campaignParamsSchema }),
  getCampaignHandler,
);

export default adminNotificationsRouter;
