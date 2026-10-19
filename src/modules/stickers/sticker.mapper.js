/**
 * Map an Image row (with `tags: { name }[]`) to the public sticker DTO.
 * Internal fields (`cloudinary_public_id`, `is_hidden`, `updated_at`) are never exposed.
 * @param {object} image
 */
export function toStickerDto(image) {
  return {
    id: image.id,
    app_id: image.app_id,
    image_url: image.image_url,
    is_animated: image.is_animated,
    is_premium: image.is_premium,
    emojis: image.emojis,
    downloads: image.downloads,
    shares: image.shares,
    tags: (image.tags ?? []).map((tag) => tag.name),
    created_at: image.created_at,
  };
}
