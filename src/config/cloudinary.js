import { v2 as cloudinary } from "cloudinary";
import { env } from "./env.js";
import { AppError, ErrorCodes } from "../lib/errors.js";

let configured = false;

/** @returns {boolean} */
export function isCloudinaryConfigured() {
  return Boolean(env.CLOUDINARY_CLOUD_NAME && env.CLOUDINARY_API_KEY && env.CLOUDINARY_API_SECRET);
}

/**
 * Return the shared, lazily-configured Cloudinary v2 client.
 * Throws if credentials are missing so misconfiguration fails loudly in the worker.
 * @returns {import("cloudinary").v2}
 */
export function getCloudinaryClient() {
  if (!configured) {
    if (!isCloudinaryConfigured()) {
      throw new AppError(
        ErrorCodes.INTERNAL_ERROR,
        "Cloudinary credentials are not configured.",
        500,
      );
    }
    cloudinary.config({
      cloud_name: env.CLOUDINARY_CLOUD_NAME,
      api_key: env.CLOUDINARY_API_KEY,
      api_secret: env.CLOUDINARY_API_SECRET,
      secure: true,
    });
    configured = true;
  }
  return cloudinary;
}

/**
 * Adapter over the Cloudinary client. Signed uploads only happen server-side
 * (worker process), never from the request path (context.md §7.6).
 *
 * @param {import("cloudinary").v2} [client] optionally injected (tests); otherwise resolved lazily.
 */
export function createCloudinaryAdapter(client) {
  const resolveClient = () => client ?? getCloudinaryClient();
  return {
    /**
     * Upload a processed WebP buffer under `tenants/{app_id}`.
     * @param {{ buffer: Buffer, appId: string }} args
     * @returns {Promise<{ url: string, publicId: string }>}
     */
    uploadSticker({ buffer, appId }) {
      const cloud = resolveClient();
      return new Promise((resolve, reject) => {
        const stream = cloud.uploader.upload_stream(
          {
            folder: `tenants/${appId}`,
            resource_type: "image",
            format: "webp",
            overwrite: false,
            invalidate: true,
          },
          (err, result) => {
            if (err || !result) {
              reject(new AppError(ErrorCodes.INTERNAL_ERROR, "Cloudinary upload failed.", 502));
              return;
            }
            resolve({ url: result.secure_url, publicId: result.public_id });
          },
        );
        stream.end(buffer);
      });
    },

    /**
     * Destroy a stored asset by its public id.
     * @param {string} publicId
     */
    async destroySticker(publicId) {
      if (!publicId) return;
      await resolveClient().uploader.destroy(publicId, {
        resource_type: "image",
        invalidate: true,
      });
    },
  };
}
