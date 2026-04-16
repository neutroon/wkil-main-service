const { PrismaClient } = require('@prisma/client');

async function fixProd() {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: "postgresql://neondb_owner:npg_bFpPOo9fU4lj@ep-sparkling-frog-adtfpf6e-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require"
      }
    }
  });

  try {
    console.log("Truncating production logging tables...");
    
    // Using raw SQL to ensure truncation works even if models are out of sync with schema
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AiCallLog" CASCADE;`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AiUsageStat" CASCADE;`);
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "BillingFailureLog" CASCADE;`);

    console.log("Truncation successful.");
  } catch (err) {
    console.error("Error truncating tables:", err);
  } finally {
    await prisma.$disconnect();
  }
}

fixProd();
