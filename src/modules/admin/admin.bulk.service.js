import { AppError } from "../../lib/errors.js";
import { enqueueBulkUpload } from "../../queues/bulk.queue.js";

/**
 * Enqueue a bulk admin upload (context.md §4.17). The heavy work (Sharp/Cloudinary)
 * stays in the worker; the request only validates the archive and creates the flow.
 *
 * @param {{
 *   prisma: any,
 *   flowProducer: { add: Function },
 *   app_id: string,
 *   body: { is_animated: boolean, is_premium: boolean, emojis: string[], tags: string[] },
 *   entries: { filename: string, buffer: Buffer }[],
 * }} args
 */
export async function createBulkUpload({ prisma, flowProducer, app_id, body, entries }) {
  const app = await prisma.app.findUnique({ where: { id: app_id }, select: { id: true } });
  if (!app) {
    throw AppError.notFound("App not found.");
  }

  const job = await enqueueBulkUpload({
    flowProducer,
    app_id,
    is_animated: body.is_animated,
    is_premium: body.is_premium,
    emojis: body.emojis,
    tags: body.tags,
    entries,
  });

  return { job_id: job.id, total: entries.length };
}
