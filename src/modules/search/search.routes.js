import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
  searchLogSchema,
  searchTrendingQuerySchema,
  searchSuggestQuerySchema,
} from "./search.schema.js";
import { postSearch, getTrending, getSuggest } from "./search.controller.js";

export const searchRouter = Router();

// Writes are rate-limited 30 req/min per device (context.md §6.5). Validation runs
// first so the device key is well-formed.
searchRouter.post(
  "/",
  validate({ body: searchLogSchema }),
  rateLimit({
    windowSeconds: 60,
    max: 30,
    keyPrefix: "rl:search-device",
    keyGenerator: (req) => req.body?.device_id ?? req.ip ?? "unknown",
  }),
  postSearch,
);

searchRouter.get("/trending", validate({ query: searchTrendingQuerySchema }), getTrending);

// Autocomplete (context.md §4.16). The query carries no device_id, so the 60/min
// limit is applied per IP.
searchRouter.get(
  "/suggest",
  rateLimit({ windowSeconds: 60, max: 60, keyPrefix: "rl:search-suggest" }),
  validate({ query: searchSuggestQuerySchema }),
  getSuggest,
);

export default searchRouter;
