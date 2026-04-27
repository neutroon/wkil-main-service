import { PrismaClient } from '@prisma/client';
import { decryptFacebookSecret } from "../src/utils/tokenCrypto";

const prisma = new PrismaClient();
const GRAPH_API = "https://graph.facebook.com/v25.0";

async function forceCleanup() {
  const account = await prisma.whatsAppAccount.findFirst({
    where: { wabaId: '902403589466601' },
    orderBy: { updatedAt: 'desc' }
  });

  if (!account) {
    console.error("Could not find account in DB to get a token.");
    return;
  }

  const token = decryptFacebookSecret(account.accessToken);

  console.log(`Attempting to force unsubscribe WABA ${account.wabaId} from Meta...`);

  const res = await fetch(`${GRAPH_API}/${account.wabaId}/subscribed_apps`, {
    method: "DELETE",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
  });

  const data = await res.json() as any;
  if (res.ok) {
    console.log("SUCCESS: Meta has been notified to unlink the app.", data);
  } else {
    console.error("FAILED to unlink from Meta:", data);
  }
}

forceCleanup()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
