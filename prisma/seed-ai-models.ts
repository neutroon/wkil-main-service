/**
 * Idempotent seed for the AiModel registry.
 *
 * Populates the table with the models currently hardcoded across the runtime
 * (modelRuntime.ts DEFAULT_MODEL_TIERS + gemini.ts MODELS map) so the registry
 * is never empty. Safe to re-run: uses upsert by modelId.
 *
 * Run: npx ts-node -r tsconfig-paths/register prisma/seed-ai-models.ts
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type SeedModel = {
  modelId: string;
  displayName: string;
  provider?: string;
  category: "chat" | "embedding" | "image" | "multimodal";
  tierOrder: number;
  isDefault?: boolean;
  isActive?: boolean;
  inputPrice?: number;
  outputPrice?: number;
  maxOutputTokens?: number;
};

// Mirrors DEFAULT_MODEL_TIERS in src/modules/ai-agent/core/modelRuntime.ts
// and the MODELS map in src/modules/ai-agent/gemini.ts (April 2026 set).
const SEED_MODELS: SeedModel[] = [
  {
    modelId: "gemini-3.1-flash-lite-preview",
    displayName: "Gemini 3.1 Flash Lite (Preview)",
    category: "chat",
    tierOrder: 0,
    isDefault: true,
    inputPrice: 0.018,
    outputPrice: 0.072,
    maxOutputTokens: 8192,
  },
  {
    modelId: "gemini-3-flash-preview",
    displayName: "Gemini 3 Flash (Preview)",
    category: "chat",
    tierOrder: 1,
    inputPrice: 0.075,
    outputPrice: 0.3,
    maxOutputTokens: 8192,
  },
  {
    modelId: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    category: "chat",
    tierOrder: 2,
    inputPrice: 0.075,
    outputPrice: 0.3,
    maxOutputTokens: 8192,
  },
  {
    modelId: "gemini-3.1-flash-image-preview",
    displayName: "Gemini 3.1 Flash Image — Nano Banana 2",
    category: "image",
    tierOrder: 0,
    isDefault: true,
    inputPrice: 0.5,
    outputPrice: 60,
  },
  {
    modelId: "gemini-embedding-001",
    displayName: "Gemini Text Embedding 001",
    category: "embedding",
    tierOrder: 0,
    isDefault: true,
  },
];

async function main() {
  for (const model of SEED_MODELS) {
    const { modelId } = model;
    // isDefault is only meaningful within a category; the service enforces a
    // single chat default at runtime, but the seed explicitly marks one.
    await prisma.aiModel.upsert({
      where: { modelId },
      update: {
        displayName: model.displayName,
        provider: model.provider ?? "google",
        category: model.category,
        tierOrder: model.tierOrder,
        // Keep isDefault/isActive as-is on re-run once an admin has changed them,
        // so this seed never silently overwrites a manual configuration choice.
      },
      create: {
        modelId,
        displayName: model.displayName,
        provider: model.provider ?? "google",
        category: model.category,
        tierOrder: model.tierOrder,
        isDefault: model.isDefault ?? false,
        isActive: model.isActive ?? true,
        inputPrice: model.inputPrice,
        outputPrice: model.outputPrice,
        maxOutputTokens: model.maxOutputTokens,
      },
    });
    // eslint-disable-next-line no-console
    console.log(`Seeded AiModel: ${modelId}`);
  }
  // eslint-disable-next-line no-console
  console.log("AI model seed complete.");
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("AI model seed failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
