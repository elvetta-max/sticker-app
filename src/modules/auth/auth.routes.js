import { Router } from "express";
import { validate } from "../../middleware/validate.js";
import { rateLimit } from "../../middleware/rateLimit.js";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { loginSchema } from "./auth.schema.js";
import { postLogin, postRefresh, postLogout, getMe } from "./auth.controller.js";

export const authRouter = Router();

// 10 attempts/min/IP (context.md §6.5); lockout is enforced in the service.
authRouter.post(
  "/login",
  rateLimit({ windowSeconds: 60, max: 10, keyPrefix: "rl:admin-login" }),
  validate({ body: loginSchema }),
  postLogin,
);

authRouter.post("/refresh", postRefresh);
authRouter.post("/logout", postLogout);

// Authenticated probe — exercises the `requireAdmin` guard.
authRouter.get("/me", requireAdmin, getMe);

export default authRouter;
