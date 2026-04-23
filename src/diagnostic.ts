import prisma from "./config/prisma";

async function main() {
  const user = await prisma.user.findUnique({
    where: { id: 3 },
    select: {
      id: true,
      email: true,
      isEmailVerified: true,
      emailVerificationToken: true,
      lastVerificationSentAt: true,
      updatedAt: true
    }
  });

  console.log("=== USER VERIFICATION STATUS ===");
  console.log(JSON.stringify(user, null, 2));
}

main().finally(() => prisma.$disconnect());
