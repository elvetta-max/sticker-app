import { Router } from "express";
import { stickerRouter } from "../modules/stickers/sticker.routes.js";
import { deviceRouter } from "../modules/device/device.routes.js";
import { searchRouter } from "../modules/search/search.routes.js";
import { favoritesRouter } from "../modules/favorites/favorites.routes.js";
import { appRouter } from "../modules/apps/app.routes.js";
import { authRouter } from "../modules/auth/auth.routes.js";
import { adminStickersRouter } from "../modules/admin/admin.stickers.routes.js";
import { adminJobsRouter } from "../modules/admin/admin.jobs.routes.js";
import { adminAppsRouter } from "../modules/admin/admin.apps.routes.js";
import { adminNotificationsRouter } from "../modules/admin/admin.notifications.routes.js";
import { adminReportsRouter } from "../modules/admin/admin.reports.routes.js";
import { adminAuditRouter } from "../modules/admin/admin.audit.routes.js";
import { maintenanceGuard } from "../middleware/maintenance.js";

/**
 * Public API router (`/api`). Feature routers are mounted here as they are built.
 * Admin surfaces live under `/api/admin` (context.md §3, strict route separation).
 */
export const apiRouter = Router();

// Maintenance gate before every router (context.md §4.18). Admin routes and the
// version/device exemptions pass through untouched.
apiRouter.use(maintenanceGuard);

apiRouter.use("/stickers", stickerRouter);
apiRouter.use("/auth", deviceRouter);
apiRouter.use("/search", searchRouter);
apiRouter.use("/user/favorites", favoritesRouter);
apiRouter.use("/apps", appRouter);
apiRouter.use("/admin", authRouter);
apiRouter.use("/admin/stickers", adminStickersRouter);
apiRouter.use("/admin/jobs", adminJobsRouter);
apiRouter.use("/admin/apps", adminAppsRouter);
apiRouter.use("/admin/notifications", adminNotificationsRouter);
apiRouter.use("/admin/reports", adminReportsRouter);
apiRouter.use("/admin/audit", adminAuditRouter);

export default apiRouter;
