// One-time admin provisioning script (context.md §7.3): the initial admin is
// created here, never through an HTTP endpoint.
//
//   node prisma/create-admin.js <username> <password>
//
import bcrypt from "bcrypt";
import { getPrisma, disconnectPrisma } from "../src/config/prisma.js";
import { env } from "../src/config/env.js";

async function main() {
  const [username, password] = process.argv.slice(2);

  if (!username || !password) {
    console.error("Usage: node prisma/create-admin.js <username> <password>");
    process.exitCode = 1;
    return;
  }
  if (password.length < 8) {
    console.error("Password must be at least 8 characters.");
    process.exitCode = 1;
    return;
  }

  const prisma = getPrisma();
  const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);

  const admin = await prisma.admin.upsert({
    where: { username },
    update: { password: passwordHash },
    create: { username, password: passwordHash },
  });

  console.log(`Admin "${admin.username}" (${admin.id}) provisioned.`);
  await disconnectPrisma();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
