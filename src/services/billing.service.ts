import prisma from "../config/prisma";
import { logger } from "../utils/logger";
import {
  MODEL_PRICING,
  EMBEDDING_RATE_PER_TOKEN,
  GROUNDING_FEE_PER_CALL,
  GROUNDING_FREE_TIER_PER_DAY,
  PLAN_TOKEN_LIMITS,
} from "../config/billing";
import { getBillingMultiplier } from "./settings.service";

/**
 * Calculates YOUR cost to Google (system cost).
 */
export function calculateSystemCost(params: {
  modelName?: string;
  promptTokens?: number;
  completionTokens?: number;
  embeddingTokens?: number;
  groundingCalls?: number;
  isGroundingFree?: boolean; // New param for free tier logic
}): number {
  let cost = 0;

  // 1. Generation Cost (Model specific)
  if (params.modelName && (params.promptTokens || params.completionTokens)) {
    const rates =
      MODEL_PRICING[params.modelName] || MODEL_PRICING["gemini-3-flash"];
    cost += (params.promptTokens || 0) * (rates.prompt / 1_000_000);
    cost += (params.completionTokens || 0) * (rates.completion / 1_000_000);
  }

  // 2. Embedding Cost
  if (params.embeddingTokens) {
    cost += params.embeddingTokens * EMBEDDING_RATE_PER_TOKEN;
  }

  // 3. Grounding Cost (with free tier awareness)
  if (params.groundingCalls && !params.isGroundingFree) {
    cost += params.groundingCalls * GROUNDING_FEE_PER_CALL;
  }

  return cost;
}

/**
 * Calculates the cost charged to the CUSTOMER (applies multiplier).
 */
export async function calculateCustomerCost(params: {
  modelName?: string;
  promptTokens?: number;
  completionTokens?: number;
  embeddingTokens?: number;
  groundingCalls?: number;
  isGroundingFree?: boolean;
}): Promise<{ systemCost: number; customerCost: number; multiplier: number }> {
  const systemCost = calculateSystemCost(params);
  const multiplier = await getBillingMultiplier();

  return {
    systemCost,
    customerCost: systemCost * multiplier,
    multiplier,
  };
}

/**
 * Pre-flight quota check with 60-second TTL cache to shield the database.
 * Throws error if quota definitely exceeded.
 */
const QUOTA_CACHE: Record<number, { isOverQuota: boolean; expiresAt: number }> = {};
const QUOTA_CACHE_TTL = 60 * 1000;

export function clearQuotaCache(businessProfileId: number) {
  delete QUOTA_CACHE[businessProfileId];
}

export async function assertQuotaAvailable(
  businessProfileId: number,
): Promise<void> {
  const cached = QUOTA_CACHE[businessProfileId];
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.isOverQuota) {
      throw new Error(`AI quota exceeded. Please upgrade.`);
    }
    return;
  }

  const profile = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { plan: true, monthlyTokensUsed: true },
  });

  if (!profile) return;

  const limit = PLAN_TOKEN_LIMITS[profile.plan] || PLAN_TOKEN_LIMITS["FREE"];
  const isOverQuota = (profile.monthlyTokensUsed || 0) >= limit;

  // Update Cache
  QUOTA_CACHE[businessProfileId] = {
    isOverQuota,
    expiresAt: Date.now() + QUOTA_CACHE_TTL,
  };

  if (isOverQuota) {
    throw new Error(
      `AI quota exceeded for plan ${profile.plan}. Please upgrade.`,
    );
  }
}

export async function recordAiUsage(params: {
  businessProfileId: number;
  modelName?: string;
  operation?: string; // e.g., "messenger_reply"
  conversationId?: string;
  promptTokens?: number;
  completionTokens?: number;
  embeddingTokens?: number;
  groundingCalls?: number;
}) {
  const {
    businessProfileId,
    modelName = "gemini-3-flash",
    operation = "unspecified",
    conversationId,
    promptTokens = 0,
    completionTokens = 0,
    embeddingTokens = 0,
    groundingCalls = 0,
  } = params;

  if (
    !promptTokens &&
    !completionTokens &&
    !embeddingTokens &&
    !groundingCalls
  ) {
    return;
  }

  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // 1. Check grounding free tier
    let isGroundingFree = false;
    if (groundingCalls > 0) {
      const dailyGrounding = await prisma.aiUsageStat.aggregate({
        where: { businessProfileId, date: today },
        _sum: { groundingCalls: true },
      });
      const totalToday = dailyGrounding._sum.groundingCalls || 0;
      if (totalToday < GROUNDING_FREE_TIER_PER_DAY) {
        isGroundingFree = true;
      }
    }

    // 2. Calculate Costs (System vs Customer)
    const { systemCost, customerCost, multiplier } =
      await calculateCustomerCost({
        ...params,
        isGroundingFree,
      });

    // 3. Perform atomic updates and logging in a transaction
    await prisma.$transaction([
      // A. Update Daily Aggregates
      prisma.aiUsageStat.upsert({
        where: {
          businessProfileId_date_modelName: {
            businessProfileId,
            date: today,
            modelName,
          },
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
          systemCost,
          customerCost,
          multiplier,
          apiCalls: 1,
        },
        update: {
          promptTokens: { increment: promptTokens },
          completionTokens: { increment: completionTokens },
          totalTokens: { increment: promptTokens + completionTokens },
          embeddingTokens: { increment: embeddingTokens },
          groundingCalls: { increment: groundingCalls },
          systemCost: { increment: systemCost },
          customerCost: { increment: customerCost },
          apiCalls: { increment: 1 },
        },
      }),

      // B. Create Granular Call Log
      prisma.aiCallLog.create({
        data: {
          businessProfileId,
          conversationId,
          modelName,
          operation,
          promptTokens,
          completionTokens,
          embeddingTokens,
          groundingCalls,
          systemCost,
          customerCost,
          multiplier,
        },
      }),

      // C. Update total usage on BusinessProfile for quota checks
      prisma.businessProfile.update({
        where: { id: businessProfileId },
        data: {
          monthlyTokensUsed: { increment: promptTokens + completionTokens },
        },
      }),
    ]);

    logger.debug("billing.record_usage_success", {
      businessProfileId,
      modelName,
      systemCost,
      customerCost,
    });
  } catch (err: any) {
    logger.error("billing.record_usage_failure.dead_lettering", {
      error: err.message,
      businessProfileId,
      modelName,
    });

    // Dead-letter: Save to separate table for manual reconciliation
    await prisma.billingFailureLog
      .create({
        data: {
          businessProfileId,
          modelName,
          promptTokens,
          completionTokens,
          embeddingTokens,
          groundingCalls,
          operation,
          error: err.message,
        },
      })
      .catch((innerErr) => {
        logger.error("billing.dead_letter_failure_CRITICAL", {
          error: innerErr.message,
        });
      });
  }
}
