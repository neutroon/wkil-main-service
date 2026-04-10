import prisma from "../src/config/prisma";

async function checkPage() {
  const pageId = "113571781631445";
  
  console.log(`Checking FacebookPage with pageId: ${pageId}...`);
  
  const page = await prisma.facebookPage.findFirst({
    where: { pageId },
    include: {
      facebookAccount: true
    }
  });
  
  if (!page) {
    console.log("CRITICAL: FacebookPage not found in database.");
  } else {
    console.log("Page found:", {
      id: page.id,
      pageName: page.pageName,
      pageId: page.pageId,
      facebookAccountId: page.facebookAccountId,
      userId: page.facebookAccount.userId,
      isActive: page.facebookAccount.isActive
    });
  }
}

checkPage().catch(console.error);
