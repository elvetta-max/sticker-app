import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { registerDeviceSchema, deviceQuerySchema } from "./device.schema.js";
import { postDevice, getDeviceHandler } from "./device.controller.js";

export const deviceRouter = Router();

// Abuse control (context.md §4.1): 30 req/min per IP + 60 req/min per device_id.
const deviceKey = (req) => req.body?.device_id ?? req.query?.device_id ?? req.ip ?? "unknown";
const deviceLimit = rateLimit({
  windowSeconds: 60,
  max: 60,
  keyPrefix: "rl:device-id",
  keyGenerator: deviceKey,
});
const ipLimit = rateLimit({ windowSeconds: 60, max: 30, keyPrefix: "rl:device-ip" });

deviceRouter.post(
  "/device",
  validate({ body: registerDeviceSchema }),
  deviceLimit,
  ipLimit,
  postDevice,
);

deviceRouter.get(
  "/device",
  validate({ query: deviceQuerySchema }),
  deviceLimit,
  ipLimit,
  getDeviceHandler,
);

export default deviceRouter;
