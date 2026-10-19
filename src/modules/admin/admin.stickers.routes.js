import { Router } from "express";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { validate } from "../../middleware/validate.js";
import {
  singleImage,
  singleZip,
  verifyImageSignature,
  verifyImageSignatureOptional,
  verifyZipContents,
} from "../../middleware/upload.js";
import { createStickerSchema, updateStickerSchema } from "./admin.stickers.schema.js";
import { bulkStickerSchema } from "./admin.bulk.schema.js";
import { stickerIdParamsSchema } from "../stickers/sticker.schema.js";
import {
  createSticker,
  putSticker,
  removeSticker,
  hideSticker,
  unhideSticker,
} from "./admin.stickers.controller.js";
import { createBulk } from "./admin.bulk.controller.js";

export const adminStickersRouter = Router();

const adminMutationLimit = rateLimit({
  windowSeconds: 60,
  max: 120,
  keyPrefix: "rl:admin-mutation",
  keyGenerator: (req) => req.admin?.id ?? req.ip ?? "unknown",
});

adminStickersRouter.post(
  "/",
  requireAdmin,
  adminMutationLimit,
  singleImage("image"),
  verifyImageSignature,
  validate({ body: createStickerSchema }),
  createSticker,
);

// Bulk ZIP upload (context.md §4.17) — one child job per image. Registered before
// `/:id` routes for clarity; the path is static so ordering does not matter.
adminStickersRouter.post(
  "/bulk",
  requireAdmin,
  adminMutationLimit,
  singleZip("zip"),
  verifyZipContents,
  validate({ body: bulkStickerSchema }),
  createBulk,
);

adminStickersRouter.put(
  "/:id",
  requireAdmin,
  adminMutationLimit,
  singleImage("image"),
  verifyImageSignatureOptional,
  validate({ params: stickerIdParamsSchema, body: updateStickerSchema }),
  putSticker,
);

adminStickersRouter.delete(
  "/:id",
  requireAdmin,
  adminMutationLimit,
  validate({ params: stickerIdParamsSchema }),
  removeSticker,
);

// Moderation soft-delete pair (context.md §4.14) — instant, reversible, evicts caches.
adminStickersRouter.post(
  "/:id/hide",
  requireAdmin,
  adminMutationLimit,
  validate({ params: stickerIdParamsSchema }),
  hideSticker,
);

adminStickersRouter.post(
  "/:id/unhide",
  requireAdmin,
  adminMutationLimit,
  validate({ params: stickerIdParamsSchema }),
  unhideSticker,
);

export default adminStickersRouter;
