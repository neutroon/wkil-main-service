import prisma from "../src/config/prisma";
import { getMetaMediaUrl } from "../src/services/meta/metaMedia.service";
import { decryptFacebookSecret } from "../src/utils/tokenCrypto";

async function testFetch() {
  try {
     const lastMediaMsg = await prisma.conversationMessage.findFirst({
        where: { NOT: { mediaId: null } },
        orderBy: { createdAt: "desc" },
        include: { conversation: true }
     });

     if (!lastMediaMsg) {
        console.error("No media messages found in DB");
        return;
     }

     console.log("Found Message ID:", lastMediaMsg.id, "Media ID:", lastMediaMsg.mediaId);
     const conversation = lastMediaMsg.conversation;

     let accessToken = "";
     if (conversation.channel === "whatsapp") {
        const account = await prisma.whatsAppAccount.findFirst({
           where: { phoneNumberId: conversation.pageId, isActive: true },
           select: { accessToken: true }
        });
        if (account) accessToken = decryptFacebookSecret(account.accessToken);
     } else if (conversation.channel === "messenger") {
        const page = await prisma.facebookPage.findFirst({
           where: { pageId: conversation.pageId, isActive: true },
           select: { pageAccessToken: true }
        });
        if (page) accessToken = decryptFacebookSecret(page.pageAccessToken);
     }

     if (!accessToken) {
        console.error("No access token found");
        return;
     }

     console.log("Found Token. Fetching Meta URL...");
     const url = await getMetaMediaUrl(lastMediaMsg.mediaId!, accessToken);
     console.log("Meta URL:", url);

     console.log("Fetching binary data...");
     const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
     console.log("Fetch Status:", response.status);
     console.log("Content-Type:", response.headers.get("content-type"));
     
     if (response.ok) {
        const buf = await response.arrayBuffer();
        console.log("Success! File size:", buf.byteLength, "bytes");
     } else {
        const err = await response.text();
        console.error("Error from Meta:", err);
     }

  } catch (e) {
     console.error("Test failed:", e);
  } finally {
     await prisma.$disconnect();
  }
}

testFetch();
