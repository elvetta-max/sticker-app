import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import { appIdParamsSchema, appVersionQuerySchema } from "./app.schema.js";
import { getVersion, getAds } from "./app.controller.js";

export const appRouter = Router();

appRouter.get(
  "/:app_id/version",
  validate({ params: appIdParamsSchema, query: appVersionQuerySchema }),
  getVersion,
);

appRouter.get("/:app_id/ads", validate({ params: appIdParamsSchema }), getAds);

export default appRouter;
