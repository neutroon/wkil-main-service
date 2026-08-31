/* E2E seed: user + business profile + knowledge documents. Safe to re-run. */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const email = "e2e-copilot@wkil.test";
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: {
        name: "E2E Owner",
        email,
        password: "e2e-not-a-login",
        isBusinessProfileCreated: true,
      },
    });
    console.log("created user", user.id);
  } else {
    console.log("reusing user", user.id);
  }

  let profile = await prisma.businessProfile.findFirst({ where: { userId: user.id } });
  if (!profile) {
    profile = await prisma.businessProfile.create({
      data: {
        userId: user.id,
        name: "Nile Coffee Roasters",
        voice: "Egyptian Arabic, warm and casual",
        tone: "Friendly",
        handoffEnabled: true,
        aiBehaviorInstructions: "Keep replies under 3 sentences. Always offer to take the order.",
        corePolicies: "No refunds on opened coffee bags. Delivery within Cairo only. Cash on delivery or card.",
        customerDetailsInstructions: "Save favorite roast and delivery address.",
        customerMemoryFields: [
          { key: "favorite_roast", label: "Favorite Roast", description: "Preferred coffee roast" },
          { key: "delivery_area", label: "Delivery Area", description: "Where to deliver" },
          { key: "birthday", label: "Birthday", description: "For annual offers" },
        ],
      },
    });
    console.log("created profile", profile.id);
  } else {
    console.log("reusing profile", profile.id);
  }

  const existing = await prisma.knowledgeDocument.count({ where: { businessProfileId: profile.id } });
  if (existing === 0) {
    await prisma.knowledgeDocument.createMany({
      data: [
        { businessProfileId: profile.id, kind: "contact", title: "Contact & Hours", content: "Working hours: Sunday to Thursday 9:00-17:00, Friday 9:00-13:00, Saturday closed. Phones: +20 100 555 0100. Address: 12 El-Nile St, Zamalek, Cairo." },
        { businessProfileId: profile.id, kind: "faq", title: "Do you ship outside Cairo?", content: "Q: Do you ship outside Cairo?\nA: No, we currently deliver within Cairo only." },
        { businessProfileId: profile.id, kind: "products", title: "Products & Services", content: "Single-origin Egyptian coffee bags (250g). Subscription boxes monthly. Wholesale for cafes." },
        { businessProfileId: profile.id, kind: "note", title: "Loyalty program", content: "Buy 9 bags, get the 10th free. Stamps are tracked per phone number in store." },
      ],
    });
    console.log("seeded 4 knowledge documents");
  } else {
    console.log("documents already present:", existing);
  }

  const documents = await prisma.knowledgeDocument.findMany({
    where: { businessProfileId: profile.id },
    select: { id: true, businessProfileId: true, kind: true, title: true, content: true },
  });
  console.log(JSON.stringify({ user_id: user.id, business_profile_id: profile.id, documents }, null, 2));
}

main().finally(() => prisma.$disconnect());
