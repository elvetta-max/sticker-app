import { getJobStatus } from "./admin.jobs.service.js";
import { getStickerQueue } from "../../queues/sticker.queue.js";

/**
 * GET /api/admin/jobs/{job_id}
 */
export async function getJob(req, res) {
  const queue = req.app.locals.stickerQueue ?? getStickerQueue();
  const data = await getJobStatus(queue, req.params.job_id);
  res.status(200).json({ success: true, data });
}
