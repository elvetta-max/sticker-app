import { AppError } from "../../lib/errors.js";

/**
 * Read the current state of a queued job (context.md §4.17 polling contract).
 *
 * @param {import("bullmq").Queue} queue
 * @param {string} jobId
 */
export async function getJobStatus(queue, jobId) {
  const job = await queue.getJob(jobId);
  if (!job) {
    throw AppError.notFound("Job not found.");
  }

  const status = await job.getState();
  const result = job.returnvalue ?? null;

  return {
    job_id: job.id,
    name: job.name,
    status,
    progress: typeof job.progress === "number" ? job.progress : 0,
    result,
    error: job.failedReason ?? null,
    ...(result && typeof result === "object" && "total" in result
      ? {
          total: result.total,
          completed: result.completed,
          failed: result.failed,
          results: result.results,
        }
      : {}),
  };
}
