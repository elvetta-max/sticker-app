import { getPrisma, disconnectPrisma } from "../src/config/prisma.js";

const prisma = getPrisma();

const DEMO_PACKAGE = "com.example.stickerapp";
const OTHER_PACKAGE = "com.example.othertenant";

const DEMO_TAGS = ["cats", "memes", "love", "reactions", "animals"];

const DEMO_STICKERS = [
  { emojis: ["😺"], tags: ["cats", "animals"], downloads: 120, shares: 14 },
  { emojis: ["😂"], tags: ["memes", "reactions"], downloads: 340, shares: 40 },
  { emojis: ["❤️"], tags: ["love", "reactions"], downloads: 220, shares: 30 },
  { emojis: ["🐶"], tags: ["animals"], downloads: 90, shares: 5 },
  { emojis: ["🙈"], tags: ["reactions", "memes"], downloads: 60, shares: 2, is_hidden: true },
  { emojis: ["🐱"], tags: ["cats"], downloads: 500, shares: 55, is_premium: true },
];

const OTHER_STICKERS = [
  { emojis: ["🚀"], tags: ["reactions"], downloads: 10, shares: 1 },
  { emojis: ["🌟"], tags: ["love"], downloads: 7, shares: 0 },
];

const imageUrl = (appPackage, n) =>
  `https://res.cloudinary.com/demo/image/upload/tenants/${appPackage}/sticker-${n}.webp`;

async function upsertApp(packageName, name) {
  return prisma.app.upsert({
    where: { package_name: packageName },
    update: {},
    create: { name, package_name: packageName },
  });
}

async function upsertTags(names) {
  const map = {};
  for (const name of names) {
    map[name] = await prisma.tag.upsert({ where: { name }, update: {}, create: { name } });
  }
  return map;
}

async function seedStickers(app, tagMap, stickers) {
  await prisma.image.deleteMany({ where: { app_id: app.id } });
  for (const [index, sticker] of stickers.entries()) {
    const n = index + 1;
    await prisma.image.create({
      data: {
        app_id: app.id,
        image_url: imageUrl(app.package_name, n),
        cloudinary_public_id: `tenants/${app.package_name}/sticker-${n}`,
        is_animated: Boolean(sticker.is_animated),
        is_premium: Boolean(sticker.is_premium),
        is_hidden: Boolean(sticker.is_hidden),
        emojis: sticker.emojis,
        downloads: sticker.downloads ?? 0,
        shares: sticker.shares ?? 0,
        tags: { connect: sticker.tags.map((name) => ({ id: tagMap[name].id })) },
      },
    });
  }
  return stickers.length;
}

async function main() {
  const demo = await upsertApp(DEMO_PACKAGE, "Demo Sticker App");
  const other = await upsertApp(OTHER_PACKAGE, "Other Tenant");

  const tagMap = await upsertTags(DEMO_TAGS);

  const demoCount = await seedStickers(demo, tagMap, DEMO_STICKERS);
  const otherCount = await seedStickers(other, tagMap, OTHER_STICKERS);

  console.log(`Seeded app "${demo.name}" (${demo.id}) with ${demoCount} stickers.`);
  console.log(`Seeded app "${other.name}" (${other.id}) with ${otherCount} stickers.`);
  console.log(`Demo app_id: ${demo.id}`);
  console.log(`Other app_id: ${other.id}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
