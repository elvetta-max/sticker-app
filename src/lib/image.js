import sharp from "sharp";
import { AppError, ErrorCodes } from "./errors.js";

/** WhatsApp sticker canvas: exactly 512×512 (context.md §2). */
export const STICKER_SIZE = 512;

/** Animated stickers are capped at 30 frames; larger ones are rejected (§4.8). */
export const MAX_ANIMATED_FRAMES = 30;

export const WEBP_QUALITY = 82;
export const WEBP_EFFORT = 4;

// Guard against decompression bombs before Sharp decodes (16384 * 16384 px).
const MAX_INPUT_PIXELS = 16384 * 16384;

/**
 * @param {number} pages
 */
export function assertFrameCount(pages) {
  if (Number.isFinite(pages) && pages > MAX_ANIMATED_FRAMES) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Animated stickers must have at most ${MAX_ANIMATED_FRAMES} frames (got ${pages}).`,
      422,
    );
  }
}

/**
 * Normalize an uploaded image into a WhatsApp-compliant WebP: exactly 512×512,
 * quality 82, effort 4. Animated sources (multi-page) are transcoded to animated
 * WebP, capped at 30 frames.
 *
 * @param {Buffer} buffer
 * @param {{ isAnimated?: boolean }} [options]
 * @returns {Promise<{ buffer: Buffer, width: number, height: number, pages: number, is_animated: boolean }>}
 */
export async function processStickerImage(buffer, { isAnimated = false } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "Empty image buffer.", 422);
  }

  let metadata;
  try {
    metadata = await sharp(buffer, {
      animated: true,
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "error",
    }).metadata();
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "Unsupported or corrupt image file.", 422);
  }

  if (!metadata.format) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "Unsupported or corrupt image file.", 422);
  }

  const pages = metadata.pages ?? 1;
  assertFrameCount(pages);

  const animated = pages > 1 || Boolean(isAnimated);
  const webpOptions = { quality: WEBP_QUALITY, effort: WEBP_EFFORT };
  if (animated) {
    webpOptions.loop = 0;
  }

  let result;
  try {
    result = await sharp(buffer, {
      animated,
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: "error",
    })
      .resize(STICKER_SIZE, STICKER_SIZE, { fit: "cover", position: "centre" })
      .webp(webpOptions)
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, "Image processing failed.", 422);
  }

  return {
    buffer: result.data,
    width: STICKER_SIZE,
    height: STICKER_SIZE,
    pages: animated ? pages : 1,
    is_animated: animated,
  };
}
