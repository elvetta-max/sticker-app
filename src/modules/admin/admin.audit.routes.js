import { Router } from "express";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import { validate } from "../../middleware/validate.js";
import { auditQuerySchema } from "./admin.audit.schema.js";
import { getAuditLogs } from "./admin.audit.controller.js";

/**
 * Read-only audit trail (context.md §7.8). Deliberately append-only: only `GET` is
 * registered, so update/delete attempts fall through to the 404 handler.
 */
export const adminAuditRouter = Router();

adminAuditRouter.get("/", requireAdmin, validate({ query: auditQuerySchema }), getAuditLogs);

export default adminAuditRouter;
