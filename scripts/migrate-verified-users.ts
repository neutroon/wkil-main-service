import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("🚀 Starting Identity Lifecycle Migration...");

  const result = await prisma.user.updateMany({
    where: {
      email: {
        not: "nbilha161@gmail.com"
      }
    },
    data: {
      isEmailVerified: true
    }
  });

  console.log(`✅ Migration complete. ${result.count} users marked as verified.`);
}

main()
  .catch((e) => {
    console.error("❌ Migration failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
