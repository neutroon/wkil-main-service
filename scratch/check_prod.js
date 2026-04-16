const { PrismaClient } = require('@prisma/client');

async function checkProd() {
  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: "postgresql://neondb_owner:npg_bFpPOo9fU4lj@ep-sparkling-frog-adtfpf6e-pooler.c-2.us-east-1.aws.neon.tech/neondb?sslmode=require"
      }
    }
  });

  try {
    console.log("Checking production tables...");
    
    const callLogs = await prisma.aiCallLog.count().catch(() => "N/A");
    const usageStats = await prisma.aiUsageStat.count().catch(() => "N/A");
    const failureLogs = await prisma.billingFailureLog.count().catch(() => "N/A");

    console.log(`AiCallLog count: ${callLogs}`);
    console.log(`AiUsageStat count: ${usageStats}`);
    console.log(`BillingFailureLog count: ${failureLogs}`);
    
    // Check if _prisma_migrations says it failed
    const migrations = await prisma.$queryRaw`SELECT * FROM "_prisma_migrations" WHERE migration_name = '20260416005324_hardening_billing_system'`.catch(() => []);
    console.log("Migration status in DB:", JSON.stringify(migrations, null, 2));

  } catch (err) {
    console.error("Error checking prod:", err);
  } finally {
    await prisma.$disconnect();
  }
}

checkProd();
