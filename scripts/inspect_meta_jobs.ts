import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  const jobs = await prisma.metaJob.findMany({ orderBy: { id: 'desc' }, take: 20 });
  console.log(JSON.stringify(jobs, null, 2));
  
  const messages = await prisma.conversationMessage.findMany({ orderBy: { id: 'desc' }, take: 10 });
  console.log("---- MESSAGES ----");
  console.log(JSON.stringify(messages, null, 2));

  // let's also check the unread/conversations
  const convs = await prisma.conversation.findMany({ orderBy: { id: 'desc' }, take: 5});
  console.log("---- CONV ----");
  console.log(JSON.stringify(convs, null, 2));
}
run().catch(console.error).finally(() => prisma.$disconnect());
