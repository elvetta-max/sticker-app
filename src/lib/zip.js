import { inflateRawSync } from "node:zlib";
import { AppError } from "./errors.js";

/** ZIP upload limits (context.md §4.17). */
export const BULK_MAX_IMAGES = 200;
export const BULK_MAX_ENTRY_BYTES = 5 * 1024 * 1024;
export const BULK_MAX_TOTAL_BYTES = 100 * 1024 * 1024;

/** Image extensions accepted inside a bulk archive. */
export const BULK_IMAGE_EXTENSIONS = Object.freeze([".png", ".jpg", ".jpeg", ".webp"]);

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;

/**
 * ZIP entry filename safety (zip-slip, context.md §4.17/§7.5). Rejects absolute paths,
 * drive letters, NUL bytes and any `..` path segment. Nested paths are allowed; the
 * caller uses only the basename for display.
 * @param {string} name
 */
export function isSafeZipPath(name) {
  if (!name || name.includes("\0")) return false;
  if (name.startsWith("/") || name.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  return !name.split(/[/\\]/).some((segment) => segment === "..");
}

/** Lowercased extension including the dot. @param {string} name */
export function zipEntryExtension(name) {
  const base = name.split(/[/\\]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot === -1 ? "" : base.slice(dot).toLowerCase();
}

function fail(message) {
  return new AppError("VALIDATION_ERROR", message, 400);
}

/**
 * Locate the End Of Central Directory record, scanning back over the (optional)
 * archive comment.
 * @param {Buffer} buffer
 */
function findEocd(buffer) {
  const stop = Math.max(0, buffer.length - (EOCD_MIN + 0xffff));
  for (let offset = buffer.length - EOCD_MIN; offset >= stop; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIG) return offset;
  }
  return -1;
}

/**
 * Minimal, dependency-free ZIP reader. Supports the two methods ZIP writers use for
 * images (0 = stored, 8 = deflate), rejects encrypted/unsafe/oversized entries and
 * enforces an entry-count cap. Sizes come from the central directory (reliable even
 * when the local header uses a data descriptor).
 *
 * @param {Buffer} buffer
 * @param {{ maxEntries?: number, maxEntryBytes?: number, maxTotalBytes?: number }} [limits]
 * @returns {{ filename: string, buffer: Buffer }[]}
 */
export function readZipEntries(buffer, limits = {}) {
  const {
    maxEntries = BULK_MAX_IMAGES,
    maxEntryBytes = BULK_MAX_ENTRY_BYTES,
    maxTotalBytes = BULK_MAX_TOTAL_BYTES,
  } = limits;

  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_MIN) {
    throw fail("File is not a valid ZIP archive.");
  }

  const eocd = findEocd(buffer);
  if (eocd === -1) throw fail("File is not a valid ZIP archive.");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  if (entryCount > maxEntries) {
    throw fail(`Archive contains more than ${maxEntries} files.`);
  }

  let cursor = buffer.readUInt32LE(eocd + 16);
  if (cursor + 4 > buffer.length) throw fail("Corrupt ZIP central directory.");

  const entries = [];
  let totalBytes = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CD_SIG) {
      throw fail("Corrupt ZIP central directory.");
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;

    if (nameStart + nameLength > buffer.length) throw fail("Corrupt ZIP entry name.");
    const filename = buffer.toString("utf8", nameStart, nameStart + nameLength);
    cursor = nameStart + nameLength + extraLength + commentLength;

    // Directories carry no data and are not images.
    if (filename.endsWith("/") || filename.endsWith("\\")) continue;
    if (!isSafeZipPath(filename)) {
      throw fail(`Unsafe path in archive: ${filename}.`);
    }
    if (flags & 0x1) throw fail(`Encrypted archive entries are not supported: ${filename}.`);
    if (method !== 0 && method !== 8) {
      throw fail(`Unsupported compression method for ${filename}.`);
    }
    if (uncompressedSize > maxEntryBytes) {
      throw fail(`Archive entry exceeds the ${maxEntryBytes / (1024 * 1024)} MB limit.`);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > maxTotalBytes) {
      throw fail("Archive expands beyond the allowed size.");
    }

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw fail(`Corrupt local header for ${filename}.`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) throw fail(`Truncated data for ${filename}.`);

    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    try {
      data = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed);
    } catch {
      throw fail(`Could not decompress ${filename}.`);
    }
    if (data.length !== uncompressedSize) throw fail(`Size mismatch for ${filename}.`);

    entries.push({ filename, buffer: data });
  }

  return entries;
}
