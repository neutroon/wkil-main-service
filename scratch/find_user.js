const { PrismaClient } = require('@prisma/client');

async function checkUser() {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: "postgresql://neondb_owner:npg_bFpPOo9fU4lj@ep-sparkling-frog-adtfpf6e-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require"
      }
    }
  });

  try {
    const user = await prisma.user.findFirst();
    console.log("Found user:", JSON.stringify(user, null, 2));
  } catch (err) {
    console.error("Error finding user:", err);
  } finally {
    await prisma.$disconnect();
  }
}

checkUser();
