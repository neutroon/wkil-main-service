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

  it("normalizes spacing in stored knowledge chunks while preserving values", () => {
    const profile = {
      ...baseProfile,
      knowledgeSections: [
        {
          title: "Programs",
          content:
            "اللايف   كوتشينج\r\n\r\n\r\nالدراسة   أونلاين   ومدتها   6 شهور\nالرابط: https://asu.eertqaa.com",
        },
      ],
    };

    const chunks = chunkBusinessProfile(profile);
    const knowledge = chunks.find((chunk) => chunk.chunkType === "custom_section");

    expect(knowledge?.content).toContain("اللايف كوتشينج");
    expect(knowledge?.content).toContain("الدراسة أونلاين ومدتها 6 شهور");
    expect(knowledge?.content).toContain("https://asu.eertqaa.com");
    expect(knowledge?.content).not.toContain("اللايف   كوتشينج");
    expect(knowledge?.content).not.toContain("\r");
  });
});
