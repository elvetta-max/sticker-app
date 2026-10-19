import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { favoritesBatchBodySchema, favoritesQuerySchema } from "./favorites.schema.js";
import { postFavoritesBatch, getFavorites } from "./favorites.controller.js";

export const favoritesRouter = Router();

// Abuse control: 60 req/min per device_id (a batch already carries up to 200 ids).
const deviceLimit = rateLimit({
  windowSeconds: 60,
  max: 60,
  keyPrefix: "rl:favorites-device",
  keyGenerator: (req) => req.body?.device_id ?? req.query?.device_id ?? req.ip ?? "unknown",
});

favoritesRouter.post(
  "/batch",
  validate({ body: favoritesBatchBodySchema }),
  deviceLimit,
  postFavoritesBatch,
);

favoritesRouter.get("/", validate({ query: favoritesQuerySchema }), deviceLimit, getFavorites);

export default favoritesRouter;
