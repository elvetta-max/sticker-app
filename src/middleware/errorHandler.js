import { ZodError } from "zod";
import { AppError, ErrorCodes, errorEnvelope } from "../lib/errors.js";
import { captureException } from "../lib/sentry.js";

/** Report only true server-side failures to Sentry (§8); 4xx stays noise-free. */
function reportServerError(err, req) {
  captureException(err, {
    request_id: req.id,
    route: req.originalUrl,
    app_id: req.app_id,
  });
}

/**
 * 404 fallback for unmatched routes.
 */
export function notFound(req, res) {
  res
    .status(404)
    .json(errorEnvelope(ErrorCodes.NOT_FOUND, `Route ${req.method} ${req.originalUrl} not found.`));
}

/** @param {ZodError} err */
function formatZodIssues(err) {
  return err.issues.map((issue) => ({
    path: issue.path.join(".") || "(root)",
    message: issue.message,
  }));
}

/**
 * Central error handler. Must keep the 4-argument signature for Express.
 * Renders every failure using the consistent error envelope.
 */
export function errorHandler(err, req, res, _next) {
  if (err instanceof ZodError) {
    return res
      .status(400)
      .json(
        errorEnvelope(
          ErrorCodes.VALIDATION_ERROR,
          "Request validation failed.",
          formatZodIssues(err),
        ),
      );
  }

  if (err instanceof AppError) {
    if (err.status >= 500) reportServerError(err, req);
    return res.status(err.status).json(errorEnvelope(err.code, err.message, err.details));
  }

  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json(errorEnvelope(ErrorCodes.VALIDATION_ERROR, "Malformed JSON body."));
  }

  const log = req.log ?? console;
  log.error?.({ err }, "unhandled error");
  reportServerError(err, req);
  return res
    .status(500)
    .json(errorEnvelope(ErrorCodes.INTERNAL_ERROR, "An unexpected error occurred."));
}

export default errorHandler;
