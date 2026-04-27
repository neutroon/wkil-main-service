import prisma from "../src/config/prisma";

async function main() {
  const accounts = await prisma.whatsAppAccount.findMany({
    select: {
      id: true,
      phoneNumberId: true,
      displayPhoneNumber: true,
      isActive: true,
      businessProfileId: true,
      user: { select: { id: true } }
    }
  });

  console.log("=== WhatsApp Accounts ===");
  console.log(JSON.stringify(accounts, null, 2));

  const conversations = await prisma.conversation.findMany({
    where: { channel: "whatsapp" },
    select: {
      id: true,
      pageId: true,
      senderId: true,
      channel: true,
      businessProfileId: true,
    }
  });

  console.log("=== WhatsApp Conversations ===");
  console.log(JSON.stringify(conversations, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
