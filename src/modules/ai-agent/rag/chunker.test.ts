import { describe, expect, it } from "vitest";
import { chunkBusinessProfile } from "./chunker";

const baseProfile = {
  name: "Acme Clinic",
  identity: "Dental clinic",
  targetAudience: "Families",
  voice: "English",
  tone: "Friendly",
  productsServices: ["Cleaning"],
  phoneNumbers: ["123"],
  address: "Main street",
  workingHours: "9-5",
  expectedUserIntents: ["Book appointment"],
  corePolicies: "Appointments required",
  faqs: [],
  knowledgeSections: [],
  scrapedMarkdown: null,
} as any;

describe("chunkBusinessProfile", () => {
  it("splits long knowledge sections into multiple searchable chunks", () => {
    const profile = {
      ...baseProfile,
      knowledgeSections: [
        {
          title: "Treatments",
          content: `${"Root canal details. ".repeat(90)}\n\n${"Whitening details. ".repeat(90)}`,
        },
      ],
    };

    const chunks = chunkBusinessProfile(profile);
    const knowledgeChunks = chunks.filter(
      (chunk) => chunk.chunkType === "custom_section",
    );

    expect(knowledgeChunks.length).toBeGreaterThan(1);
    expect(knowledgeChunks[0].content).toContain("[KNOWLEDGE]: Treatments");
  });

  it("splits scraped markdown instead of storing it as one oversized chunk", () => {
    const profile = {
      ...baseProfile,
      scrapedMarkdown: "Long scraped page. ".repeat(180),
    };

    const chunks = chunkBusinessProfile(profile);
    const scrapedChunks = chunks.filter(
      (chunk) => chunk.chunkType === "raw_content",
    );

    expect(scrapedChunks.length).toBeGreaterThan(1);
    expect(scrapedChunks[0].content).toContain("[SCRAPED_CONTENT 1]");
  });
});
