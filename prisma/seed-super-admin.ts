/**
 * Idempotent seed for the initial super_admin user.
 *
 * Creates a platform-level super admin that can manage all workspaces,
 * plans, quotas, and other admins. Safe to re-run: if a user with the
 * given email already exists, it will be promoted to super_admin
 * (active + email verified) rather than duplicated.
 *
 * Run: npx ts-node -r tsconfig-paths/register prisma/seed-super-admin.ts
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const SUPER_ADMIN_NAME = "Platform Owner";
const SUPER_ADMIN_EMAIL = "nbilha164@gmail.com";
const SUPER_ADMIN_PASSWORD = "102003000@Aa";

async function main() {
  const hashed = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 10);

  const existing = await prisma.user.findUnique({
    where: { email: SUPER_ADMIN_EMAIL },
    select: { id: true, role: true, isActive: true, isEmailVerified: true },
  });

  if (existing) {
    const user = await prisma.user.update({
      where: { email: SUPER_ADMIN_EMAIL },
      data: {
        name: SUPER_ADMIN_NAME,
        password: hashed,
        role: "super_admin",
        isActive: true,
        isEmailVerified: true,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });
    // eslint-disable-next-line no-console
    console.log(`Updated existing user -> super_admin: ${user.email}`);
    return user;
  }

  const user = await prisma.user.create({
    data: {
      name: SUPER_ADMIN_NAME,
      email: SUPER_ADMIN_EMAIL,
      password: hashed,
      role: "super_admin",
      isActive: true,
      isEmailVerified: true,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
  });
  // eslint-disable-next-line no-console
  console.log(`Seeded super_admin: ${user.email}`);
  return user;
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("Super admin seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
