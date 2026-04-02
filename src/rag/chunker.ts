import { Prisma } from "@prisma/client";

type BusinessProfileWithFaqs = Prisma.BusinessProfileGetPayload<{
  include: { faqs: true };
}>;

export function chunkBusinessProfile(profile: BusinessProfileWithFaqs) {
  const chunks: { chunkType: string; content: string; chunkIndex: number }[] =
    [];
  let index = 0;

  // identity
  chunks.push({
    chunkType: "identity",
    chunkIndex: index++,
    content: `Business: ${profile.name}
  Identity: ${profile.identity}
  Target Audience: ${profile.targetAudience}
  Voice: ${profile.voice}
  Tone: ${profile.tone}`,
  });

  // products/services — one chunk per item
  profile.productsServices.forEach((item) => {
    chunks.push({
      chunkType: "product",
      chunkIndex: index++,
      content: `Product/Service: ${item}`,
    });
  });

  // contact
  chunks.push({
    chunkType: "contact",
    chunkIndex: index++,
    content: `Phone: ${profile.phoneNumbers.join(", ")}
  Address: ${profile.address ?? "N/A"}
  Working Hours: ${profile.workingHours ?? "N/A"}`,
  });

  // faqs — one chunk per FAQ
  profile.faqs.forEach((faq) => {
    chunks.push({
      chunkType: "faq",
      chunkIndex: index++,
      content: `Question: ${faq.question}\nAnswer: ${faq.answer}`,
    });
  });

  // intents + policies
  chunks.push({
    chunkType: "intents",
    chunkIndex: index++,
    content: `Expected Intents: ${profile.expectedUserIntents.join(", ")}
  Core Policies: ${profile.corePolicies}`,
  });

  // raw scraped content (only if exists)
  if (profile.scrapedMarkdown) {
    chunks.push({
      chunkType: "raw_content",
      chunkIndex: index++,
      content: profile.scrapedMarkdown,
    });
  }

  return chunks;
}
