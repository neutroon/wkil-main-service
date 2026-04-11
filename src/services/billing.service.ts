import prisma from "../config/prisma";
import { logger } from "../utils/logger";
import { MODEL_PRICING, EMBEDDING_RATE_PER_TOKEN, GROUNDING_FEE_PER_CALL } from "../config/billing";

/**
 * Calculates current system cost for a batch of tokens/calls.
 */
export function calculateSystemCost(params: {
  modelName?: string;
  promptTokens?: number;
  completionTokens?: number;
  embeddingTokens?: number;
  groundingCalls?: number;
}): number {
  let cost = 0;

  // 1. Generation Cost (Model specific)
  if (params.modelName && (params.promptTokens || params.completionTokens)) {
    const rates = MODEL_PRICING[params.modelName] || MODEL_PRICING["gemini-2.0-flash"]; // Default fallback
    cost += (params.promptTokens || 0) * (rates.prompt / 1_000_000);
    cost += (params.completionTokens || 0) * (rates.completion / 1_000_000);
  }

  // 2. Embedding Cost
  if (params.embeddingTokens) {
    cost += params.embeddingTokens * EMBEDDING_RATE_PER_TOKEN;
  }

  // 3. Grounding Cost
  if (params.groundingCalls) {
    cost += params.groundingCalls * GROUNDING_FEE_PER_CALL;
  }

  return cost;
}

/**
 * Records AI usage with immediate cost locking for production-grade billing.
 * Uses Prisma Upsert to maintain daily aggregation per profile and model.
 */
export async function recordAiUsage(params: {
  businessProfileId: number;
  modelName?: string;
  promptTokens?: number;
  completionTokens?: number;
  embeddingTokens?: number;
  groundingCalls?: number;
}) {
  const { 
    businessProfileId, 
    modelName = "gemini-2.0-flash", 
    promptTokens = 0, 
    completionTokens = 0, 
    embeddingTokens = 0, 
    groundingCalls = 0 
  } = params;

  // Only record if there is actual usage
  if (!promptTokens && !completionTokens && !embeddingTokens && !groundingCalls) {
    return;
  }

  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Calculate the cost for THIS specific delta 
    const deltaCost = calculateSystemCost(params);

    await prisma.aiUsageStat.upsert({
      where: {
        businessProfileId_date_modelName: {
          businessProfileId,
          date: today,
          modelName
        }
      },
      create: {
        businessProfileId,
        date: today,
        modelName,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        embeddingTokens,
        groundingCalls,
        systemCost: deltaCost,
        apiCalls: 1
      },
      update: {
        promptTokens: { increment: promptTokens },
        completionTokens: { increment: completionTokens },
        totalTokens: { increment: promptTokens + completionTokens },
        embeddingTokens: { increment: embeddingTokens },
        groundingCalls: { increment: groundingCalls },
        systemCost: { increment: deltaCost },
        apiCalls: { increment: 1 }
      }
    });

    logger.debug("billing.record_usage", { 
      businessProfileId, 
      modelName, 
      tokens: promptTokens + completionTokens, 
      cost: deltaCost 
    });
  } catch (err: any) {
    logger.error("billing.record_usage_failure", { 
      error: err.message, 
      businessProfileId, 
      modelName 
    });
  }
}
