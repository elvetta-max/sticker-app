/**
 * Canonical error codes and the AppError type used across the API.
 * Every error response uses the envelope: { success: false, error: { code, message, details? } }
 */

export const ErrorCodes = Object.freeze({
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  STICKER_NOT_FOUND: "STICKER_NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  UNAUTHORIZED: "UNAUTHORIZED",
  INVALID_CREDENTIALS: "INVALID_CREDENTIALS",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  FORBIDDEN: "FORBIDDEN",
  CONFLICT: "CONFLICT",
  MAINTENANCE_MODE: "MAINTENANCE_MODE",
  NOT_READY: "NOT_READY",
  INTERNAL_ERROR: "INTERNAL_ERROR",
});

export class AppError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   * @param {unknown} [details]
   */
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    this.details = details;
  }

  static notFound(message = "Resource not found.") {
    return new AppError(ErrorCodes.NOT_FOUND, message, 404);
  }

  static validation(message = "Request validation failed.", details) {
    return new AppError(ErrorCodes.VALIDATION_ERROR, message, 400, details);
  }

  static unauthorized(message = "Authentication required.") {
    return new AppError(ErrorCodes.UNAUTHORIZED, message, 401);
  }

  static forbidden(message = "You do not have access to this resource.") {
    return new AppError(ErrorCodes.FORBIDDEN, message, 403);
  }
}

/**
 * Build the standard error envelope. `details` is only included when provided.
 * @param {string} code
 * @param {string} message
 * @param {unknown} [details]
 */
export function errorEnvelope(code, message, details) {
  const error = { code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return { success: false, error };
}
