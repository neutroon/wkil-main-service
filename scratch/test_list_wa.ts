import { listWhatsAppConversations } from "../src/services/meta/conversation.service";
import prisma from "../src/config/prisma";

async function testList() {
  const result = await listWhatsAppConversations(1, 1, 20);
  console.log(JSON.stringify(result, null, 2));
}

testList()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
