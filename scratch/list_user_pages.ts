import prisma from "../src/config/prisma";

async function listUserPages() {
  const userId = 1; // Assuming the user ID is 1 based on previous interactions, but I should check.
  
  console.log(`Listing all FacebookPages for userId: ${userId}...`);
  
  const pages = await prisma.facebookPage.findMany({
    where: {
      facebookAccount: {
        userId: userId
      }
    },
    include: {
      facebookAccount: true
    }
  });
  
  console.log(`Found ${pages.length} pages:`);
  pages.forEach(p => {
    console.log(`- ${p.pageName} (pageId: ${p.pageId}) [AccID: ${p.facebookAccountId}]`);
  });
}

listUserPages().catch(console.error);
