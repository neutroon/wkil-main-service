const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function backfill() {
  console.log("Starting Legacy Message Repair...");
  
  const result = await prisma.conversationMessage.updateMany({
    where: {
      OR: [
        { intent: "SALES_DM" },
        { handoffCategory: "PRIVATE_DM_REPLY" }
      ]
    },
    data: {
      isPrivate: true,
      origin: "facebook_comment_reply"
    }
  });

  console.log(`Successfully repaired ${result.count} historical messages.`);
  process.exit(0);
}

backfill().catch(err => {
  console.error(err);
  process.exit(1);
});
