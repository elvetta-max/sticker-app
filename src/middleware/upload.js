import multer from "multer";
import { AppError, ErrorCodes } from "../lib/errors.js";
import { readZipEntries, zipEntryExtension, BULK_IMAGE_EXTENSIONS } from "../lib/zip.js";

/** 5 MB upload cap (context.md §4.8). */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** MIME allowlist enforced before the file ever reaches the worker. */
export const ALLOWED_IMAGE_MIME = Object.freeze(["image/png", "image/jpeg", "image/webp"]);

/**
 * Detect an image type from its leading bytes (magic-number check, context.md §7.5).
 * @param {Buffer} buffer
 * @returns {"image/png" | "image/jpeg" | "image/webp" | null}
 */
export function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }

  return null;
}

const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_IMAGE_MIME.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new AppError(ErrorCodes.VALIDATION_ERROR, `Unsupported file type: ${file.mimetype}.`, 415));
  },
});

/**
 * Multer single-file middleware wrapper that maps Multer errors onto AppErrors.
 * @param {string} [field]
 */
export function singleImage(field = "image") {
  const handler = multerUpload.single(field);
  return function uploadSingleImage(req, res, next) {
    handler(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return next(
            new AppError(
              ErrorCodes.VALIDATION_ERROR,
              `Image exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit.`,
              413,
            ),
          );
        }
        return next(new AppError(ErrorCodes.VALIDATION_ERROR, `Upload error: ${err.code}.`, 400));
      }
      return next(err);
    });
  };
}

/**
 * Verify the uploaded buffer's magic bytes match an allowed image type and that the
 * declared mimetype agrees. Attaches `req.file.detectedMime`.
 */
export function verifyImageSignature(req, _res, next) {
  if (!req.file) {
    return next(AppError.validation("An image file is required."));
  }

  const detected = sniffImageType(req.file.buffer);
  if (!detected || detected !== req.file.mimetype) {
    return next(
      new AppError(
        ErrorCodes.VALIDATION_ERROR,
        "File content does not match a supported image type.",
        415,
      ),
    );
  }

  req.file.detectedMime = detected;
  return next();
}

/**
 * Like {@link verifyImageSignature} but allows requests without a file
 * (used by PUT, where the image is optional).
 */
export function verifyImageSignatureOptional(req, res, next) {
  if (!req.file) return next();
  return verifyImageSignature(req, res, next);
}

/** 50 MB bulk ZIP cap (context.md §4.17). */
export const MAX_BULK_ZIP_BYTES = 50 * 1024 * 1024;

/** Leading bytes shared by every ZIP archive (PK\x03\x04). */
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/** @param {Buffer} buffer */
export function isZipSignature(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < ZIP_MAGIC.length) return false;
  return ZIP_MAGIC.every((byte, index) => buffer[index] === byte);
}

const bulkUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BULK_ZIP_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["application/zip", "application/x-zip-compressed", "application/octet-stream"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    cb(new AppError(ErrorCodes.VALIDATION_ERROR, `Unsupported file type: ${file.mimetype}.`, 415));
  },
});

/**
 * Multer single-ZIP middleware (context.md §4.17) mapping Multer errors onto AppErrors.
 * @param {string} [field]
 */
export function singleZip(field = "zip") {
  const handler = bulkUpload.single(field);
  return function uploadSingleZip(req, res, next) {
    handler(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return next(
            new AppError(
              ErrorCodes.VALIDATION_ERROR,
              `Archive exceeds the ${MAX_BULK_ZIP_BYTES / (1024 * 1024)} MB limit.`,
              413,
            ),
          );
        }
        return next(new AppError(ErrorCodes.VALIDATION_ERROR, `Upload error: ${err.code}.`, 400));
      }
      return next(err);
    });
  };
}

/**
 * Verify the uploaded archive is really a ZIP (magic bytes) and that every image entry
 * inside it has a supported signature. Rejects the request before anything is enqueued.
 * Attaches the parsed entries as `req.zipEntries`.
 */
export function verifyZipContents(req, _res, next) {
  if (!req.file) {
    return next(AppError.validation("A ZIP archive is required."));
  }
  if (!isZipSignature(req.file.buffer)) {
    return next(new AppError(ErrorCodes.VALIDATION_ERROR, "File is not a valid ZIP archive.", 415));
  }

  let entries;
  try {
    entries = readZipEntries(req.file.buffer);
  } catch (err) {
    return next(err);
  }

  const images = [];
  for (const entry of entries) {
    if (!BULK_IMAGE_EXTENSIONS.includes(zipEntryExtension(entry.filename))) continue;
    if (!sniffImageType(entry.buffer)) {
      return next(
        new AppError(
          ErrorCodes.VALIDATION_ERROR,
          `Archive entry is not a supported image: ${entry.filename}.`,
          415,
        ),
      );
    }
    images.push(entry);
  }

  if (images.length === 0) {
    return next(AppError.validation("Archive contains no supported images (png, jpeg, webp)."));
  }

  req.zipEntries = images;
  return next();
}
