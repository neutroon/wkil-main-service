import { Prisma } from "@prisma/client";

type BusinessProfileWithFaqs = Prisma.BusinessProfileGetPayload<{
  include: { faqs: true; knowledgeSections: true };
}>;

const MAX_CHUNK_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 150;

function normalizeKnowledgeText(text: string): string {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLongText(
  text: string,
  maxChars = MAX_CHUNK_CHARS,
  overlapChars = CHUNK_OVERLAP_CHARS,
): string[] {
  const normalized = normalizeKnowledgeText(text);
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks: string[] = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length);
    if (end < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf("\n\n", end);
      const sentenceBreak = normalized.lastIndexOf(". ", end);
      const lineBreak = normalized.lastIndexOf("\n", end);
      const splitAt = Math.max(paragraphBreak, sentenceBreak, lineBreak);

      if (splitAt > start + Math.floor(maxChars * 0.5)) {
        end = splitAt + (splitAt === sentenceBreak ? 1 : 0);
      }
    }

    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;

    start = Math.max(0, end - overlapChars);
  }

  return chunks;
}

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

  // contact (legacy/structured fallback)
  if (profile.phoneNumbers.length > 0 || profile.address || profile.workingHours) {
    chunks.push({
      chunkType: "contact",
      chunkIndex: index++,
      content: `Phone: ${profile.phoneNumbers.join(", ")}
    Address: ${profile.address ?? "N/A"}
    Working Hours: ${profile.workingHours ?? "N/A"}`,
    });
  }

  // faqs — one chunk per FAQ
  profile.faqs.forEach((faq) => {
    chunks.push({
      chunkType: "faq",
      chunkIndex: index++,
      content: `Question: ${faq.question}\nAnswer: ${faq.answer}`,
    });
  });

  // intents + policies (legacy fallback)
  if (profile.expectedUserIntents.length > 0 || profile.corePolicies) {
    chunks.push({
      chunkType: "intents",
      chunkIndex: index++,
      content: `Expected Intents: ${profile.expectedUserIntents.join(", ")}
    Core Policies: ${profile.corePolicies || "N/A"}`,
    });
  }

  // custom knowledge sections
  profile.knowledgeSections.forEach((section) => {
    splitLongText(section.content).forEach((content, sectionIndex) => {
      chunks.push({
        chunkType: "custom_section",
        chunkIndex: index++,
        content: `[KNOWLEDGE]: ${section.title} (${sectionIndex + 1})\n${content}`,
      });
    });
  });

  // raw scraped content (only if exists)
  if (profile.scrapedMarkdown) {
    splitLongText(profile.scrapedMarkdown).forEach((content, rawIndex) => {
      chunks.push({
        chunkType: "raw_content",
        chunkIndex: index++,
        content: `[SCRAPED_CONTENT ${rawIndex + 1}]\n${content}`,
      });
    });
  }

  return chunks;
}

