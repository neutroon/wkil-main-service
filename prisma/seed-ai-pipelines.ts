/**
 * Idempotent seed for the AiPipeline registry.
 *
 * Creates the 11 platform pipelines with sensible defaults. All text-class
 * pipelines start with `inheritsChatDefault = true`, so deployed behavior is
 * IDENTICAL to before this feature (every text surface follows the chat model
 * selection). Embeddings and image-gen are pinned to their own model class and
 * cannot inherit chat.
 *
 * Safe to re-run: upsert by key, and on update we never overwrite an admin's
 * configured modelIds/perf knobs — only display fields are refreshed.
 *
 * Run: npx ts-node -r tsconfig-paths/register prisma/seed-ai-pipelines.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type SeedPipeline = {
  key: string;
  displayName: string;
  description: string;
  modelClass: "text" | "embedding" | "image";
  // Only used on initial create. Never overwritten on re-run.
  modelIds?: string[];
  inheritsChatDefault: boolean;
};

const SEED_PIPELINES: SeedPipeline[] = [
  {
    key: "chat",
    displayName: "Chat Agent",
    description:
      "Live customer conversations across Messenger, WhatsApp and the web widget (decision routing, tool calls, replies).",
    modelClass: "text",
    inheritsChatDefault: true, // chat IS the anchor; resolves from the AiModel chat tiers
  },
  {
    key: "media_understanding",
    displayName: "Media Understanding",
    description:
      "Describes images customers send in chat so the agent can act on them.",
    modelClass: "text",
    inheritsChatDefault: true,
  },
  {
    key: "follow_up",
    displayName: "Follow-up Messages",
    description:
      "Automated follow-up replies sent to leads. High volume — a common place to use a cheaper model.",
    modelClass: "text",
    inheritsChatDefault: true,
  },
  {
    key: "content",
    displayName: "Content Generation",
    description: "Generates social post content from a brief.",
    modelClass: "text",
    inheritsChatDefault: true,
  },
  {
    key: "content_brief",
    displayName: "Content Briefs & Audit",
    description: "Competitor discovery, search summaries and content audits.",
    modelClass: "text",
    inheritsChatDefault: true,
  },
  {
    key: "content_plan",
    displayName: "Content Plans & Strategy",
    description: "Research and strategy generation for content planning.",
    modelClass: "text",
    inheritsChatDefault: true,
  },
  {
    key: "business_analysis",
    displayName: "Business Analysis",
    description:
      "Onboarding AI: discovers strategic links and extracts business identity from scraped content.",
    modelClass: "text",
    inheritsChatDefault: true,
  },
  {
    key: "memory_capture",
    displayName: "Memory Capture",
    description:
      "Background job that extracts customer memory from conversations for personalization.",
    modelClass: "text",
    inheritsChatDefault: true,
  },
  {
    key: "image_gen",
    displayName: "Image Generation",
    description:
      "Branded visual generation (Art Director prompt enhancement + image output).",
    modelClass: "image",
    // Image class cannot inherit chat; pinned to image-capable models.
    modelIds: ["gemini-3.1-flash-image-preview", "gemini-3-flash-preview"],
    inheritsChatDefault: false,
  },
  {
    key: "embeddings",
    displayName: "RAG Embeddings",
    description:
      "Vector embeddings for knowledge-base ingest and retrieval. Pinned to a 768-dimension model for pgvector compatibility.",
    modelClass: "embedding",
    modelIds: ["gemini-embedding-001"],
    inheritsChatDefault: false,
  },
  {
    key: "recovery",
    displayName: "Recovery Reply",
    description:
      "Safe fallback reply when the primary model fails. Follows chat by default.",
    modelClass: "text",
    inheritsChatDefault: true,
  },
];

async function main() {
  for (const p of SEED_PIPELINES) {
    await prisma.aiPipeline.upsert({
      where: { key: p.key },
      update: {
        displayName: p.displayName,
        description: p.description,
        // modelClass, modelIds, perf knobs, inheritsChatDefault, isActive are
        // intentionally NOT updated here once an admin has configured them.
      },
      create: {
        key: p.key,
        displayName: p.displayName,
        description: p.description,
        modelClass: p.modelClass,
        modelIds: p.modelIds ?? [],
        inheritsChatDefault: p.inheritsChatDefault,
        isActive: true,
      },
    });
    // eslint-disable-next-line no-console
    console.log(`Seeded AiPipeline: ${p.key}`);
  }
  // eslint-disable-next-line no-console
  console.log("AI pipeline seed complete.");
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("AI pipeline seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
