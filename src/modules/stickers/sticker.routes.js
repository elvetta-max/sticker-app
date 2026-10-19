import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import {
  stickerListQuerySchema,
  stickerIdParamsSchema,
  stickerGetQuerySchema,
  stickerDailyQuerySchema,
  stickerEngagementParamsSchema,
  stickerEngagementBodySchema,
  stickerReportParamsSchema,
  stickerReportBodySchema,
} from "./sticker.schema.js";
import {
  getStickers,
  getStickerById,
  getDailySticker,
  trackDownload,
  trackShare,
  postReport,
} from "./sticker.controller.js";

export const stickerRouter = Router();

stickerRouter.get("/", validate({ query: stickerListQuerySchema }), getStickers);

// Fixed path before `/:id` so "daily" is not parsed as a sticker UUID (§4.15).
stickerRouter.get(
  "/daily",
  rateLimit({ windowSeconds: 60, max: 120, keyPrefix: "rl:sticker-daily" }),
  validate({ query: stickerDailyQuerySchema }),
  getDailySticker,
);

stickerRouter.get(
  "/:id",
  rateLimit({ windowSeconds: 60, max: 120, keyPrefix: "rl:sticker" }),
  validate({ params: stickerIdParamsSchema, query: stickerGetQuerySchema }),
  getStickerById,
);

// Engagement trackers — abuse control per context.md §4.4: 60/min per device_id
// plus 300/min per IP. Body is validated first so the device key is well-formed.
const engagementDeviceLimit = rateLimit({
  windowSeconds: 60,
  max: 60,
  keyPrefix: "rl:engagement-device",
  keyGenerator: (req) => req.body?.device_id ?? req.ip ?? "unknown",
});
const engagementIpLimit = rateLimit({
  windowSeconds: 60,
  max: 300,
  keyPrefix: "rl:engagement-ip",
});

const engagementGuards = [
  validate({ params: stickerEngagementParamsSchema, body: stickerEngagementBodySchema }),
  engagementDeviceLimit,
  engagementIpLimit,
];

stickerRouter.post("/:id/download", ...engagementGuards, trackDownload);
stickerRouter.post("/:id/share", ...engagementGuards, trackShare);

// Content reporting (context.md §4.14): 10/min per device_id. Body validated first
// so the device key is well-formed.
const reportDeviceLimit = rateLimit({
  windowSeconds: 60,
  max: 10,
  keyPrefix: "rl:report-device",
  keyGenerator: (req) => req.body?.device_id ?? req.ip ?? "unknown",
});

stickerRouter.post(
  "/:id/report",
  validate({ params: stickerReportParamsSchema, body: stickerReportBodySchema }),
  reportDeviceLimit,
  postReport,
);

export default stickerRouter;
