import { AppError } from "../../lib/errors.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { toStickerDto } from "../stickers/sticker.mapper.js";

/** Standard response message for a successful batch sync (context.md §4.5). */
export const FAVORITES_SYNC_MESSAGE = "Batch favorites synchronized successfully.";

/**
 * Verify a tenant exists. Public favorites surfaces are tenant-scoped, and an
 * unknown `app_id` resolves to a generic 404 (never leaking tenant existence).
 * @param {any} prisma
 * @param {string} app_id
 */
async function assertApp(prisma, app_id) {
  const app = await prisma.app.findUnique({ where: { id: app_id }, select: { id: true } });
  if (!app) {
    throw AppError.notFound("App not found.");
  }
}

/**
 * Apply a batch of favorite ADD/REMOVE operations, idempotently (context.md §4.5).
 *
 * The client's offline queue may replay the same batch on retry: `ADD` relies on
 * `skipDuplicates` against the `@@unique([device_id, image_id])` key and `REMOVE`
 * is a plain filtered delete, so replays are safe. `processed_count` is the number
 * of rows actually inserted/removed (0 on an exact replay).
 *
 * `ADD` only persists favorites for visible stickers owned by the same tenant — a
 * sticker id from another tenant (or a hidden one) is silently dropped, never stored.
 *
 * @param {{
 *   prisma: any,
 *   device_id: string,
 *   app_id: string,
 *   favorite_image_ids: string[],
 *   action: "ADD"|"REMOVE",
 * }} args
 * @returns {Promise<{ processed_count: number }>}
 */
export async function syncFavorites({ prisma, device_id, app_id, favorite_image_ids, action }) {
  await assertApp(prisma, app_id);

  const uniqueIds = [...new Set(favorite_image_ids)];

  if (action === "ADD") {
    let validIds = uniqueIds;
    if (uniqueIds.length > 0) {
      const images = await prisma.image.findMany({
        where: { id: { in: uniqueIds }, app_id, is_hidden: false },
        select: { id: true },
      });
      validIds = images.map((image) => image.id);
    }

    const result = await prisma.$transaction((tx) =>
      tx.favorite.createMany({
        data: validIds.map((image_id) => ({ device_id, app_id, image_id })),
        skipDuplicates: true,
      }),
    );
    return { processed_count: result.count };
  }

  const result = await prisma.$transaction((tx) =>
    tx.favorite.deleteMany({
      where: { device_id, app_id, image_id: { in: uniqueIds } },
    }),
  );
  return { processed_count: result.count };
}

/**
 * List a device's favorites for a tenant, newest-first and cursor-paginated
 * (context.md §4.5). Hidden stickers are excluded so they never surface in the
 * client's re-hydrated state.
 *
 * @param {{ prisma: any, device_id: string, app_id: string, cursor?: string, limit: number }} args
 * @returns {Promise<{ data: object[], next_cursor: string|null }>}
 */
export async function listFavorites({ prisma, device_id, app_id, cursor, limit }) {
  await assertApp(prisma, app_id);

  const conditions = [{ device_id }, { app_id }, { image: { is: { is_hidden: false, app_id } } }];

  if (cursor) {
    const { createdAt, id } = decodeCursor(cursor);
    conditions.push({
      OR: [
        { created_at: { lt: createdAt } },
        { AND: [{ created_at: createdAt }, { id: { lt: id } }] },
      ],
    });
  }

  const rows = await prisma.favorite.findMany({
    where: { AND: conditions },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    take: limit + 1,
    include: { image: { include: { tags: { select: { name: true } } } } },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page.at(-1);
  const next_cursor =
    hasMore && last ? encodeCursor({ createdAt: last.created_at, id: last.id }) : null;

  return { data: page.map((row) => toStickerDto(row.image)), next_cursor };
}
