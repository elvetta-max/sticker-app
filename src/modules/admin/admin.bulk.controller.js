import { createBulkUpload } from "./admin.bulk.service.js";
import { getBulkFlowProducer } from "../../queues/bulk.queue.js";
import { AuditAction, AuditTarget, recordAudit } from "../../lib/audit.js";

/**
 * POST /api/admin/stickers/bulk — accepts a ZIP archive and enqueues one child job per
 * extracted image (context.md §4.17). Responds `202 { job_id }`.
 */
export async function createBulk(req, res) {
  const flowProducer = req.app.locals.flowProducer ?? getBulkFlowProducer();

  const result = await createBulkUpload({
    prisma: req.app.locals.prisma,
    flowProducer,
    app_id: req.body.app_id,
    body: req.body,
    entries: req.zipEntries,
  });

  await recordAudit({
    prisma: req.app.locals.prisma,
    actor: req.admin,
    action: AuditAction.STICKER_BULK,
    target_type: AuditTarget.JOB,
    target_id: result.job_id,
    app_id: req.body.app_id,
  });

  res.status(202).json({ success: true, ...result });
}
