import prisma from "../config/prisma";
import { logger } from "../utils/logger";
import {
  MODEL_PRICING,
  EMBEDDING_RATE_PER_TOKEN,
  GROUNDING_FEE_PER_CALL,
  GROUNDING_FREE_TIER_PER_DAY,
  PLAN_CREDIT_LIMITS,
  CREDIT_VALUE_USD,
} from "../config/billing";
import { getBillingMultiplier } from "./settings.service";
import { AppError } from "../middlewares/errorHandler.middleware";

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
    const rates = MODEL_PRICING[params.modelName];

    if (!rates) {
      logger.warn("billing.calculate_cost.missing_model_rates", {
        modelName: params.modelName,
        fallbackTo: "gemini-3-flash",
      });
    }

    const activeRates = rates || MODEL_PRICING["gemini-3-flash"];
    cost += (params.promptTokens || 0) * (activeRates.prompt / 1_000_000);
    cost += (params.completionTokens || 0) * (activeRates.completion / 1_000_000);
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

export function clearQuotaCache(userId: number) {
  delete QUOTA_CACHE[userId];
}

export async function assertQuotaAvailable(
  userId: number,
  businessProfileId?: number | null,
): Promise<void> {
  const cached = QUOTA_CACHE[userId];
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.isOverQuota) {
      throw new Error(`AI credit quota exceeded. Please upgrade.`);
    }
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { plan: true, monthlyCreditQuota: true, monthlyCreditsUsed: true },
  });

  if (!user) {
    throw new Error("User not found");
  }

  // Priority: 1. Admin Override (monthlyCreditQuota) 2. Plan Limit
  const limit =
    user.monthlyCreditQuota ||
    PLAN_CREDIT_LIMITS[user.plan] ||
    PLAN_CREDIT_LIMITS["FREE"];

  const isOverQuota = (user.monthlyCreditsUsed || 0) >= limit;

  // Update Cache
  QUOTA_CACHE[userId] = {
    isOverQuota,
    expiresAt: Date.now() + QUOTA_CACHE_TTL,
  };

  if (isOverQuota) {
    throw new AppError(
      `AI credit quota exceeded for plan ${user.plan}. Please upgrade for more credits.`,
      402,
    );
  }
}

export async function recordAiUsage(params: {
  userId: number;
  businessProfileId?: number | null;
  modelName?: string;
  operation?: string; // e.g., "messenger_reply"
  conversationId?: string;
  promptTokens?: number;
  completionTokens?: number;
  embeddingTokens?: number;
  groundingCalls?: number;
}) {
  const {
    userId,
    businessProfileId,
    modelName = "gemini-3-flash",
    operation = "unspecified",
    conversationId,
    promptTokens = 0,
    completionTokens = 0,
    embeddingTokens = 0,
    groundingCalls = 0,
  } = params;

  const totalTokens = promptTokens + completionTokens;

  if (
    !promptTokens &&
    !completionTokens &&
    !embeddingTokens &&
    !groundingCalls
  ) {
    return;
  }

  // Mandatory for production safety
  if (!userId) {
    logger.error("billing.record_usage_failure.missing_user_id", { operation });
    return;
  }

  if (!businessProfileId) {
    logger.debug("billing.record_usage_onboarding", { userId, operation });
  }

  try {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // 1. Check grounding free tier
    let isGroundingFree = false;
    if (groundingCalls > 0) {
      const dailyGrounding = await prisma.aiUsageStat.aggregate({
        where: {
          userId,
          businessProfileId: businessProfileId || 0,
          date: today,
        },
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

    // 2.5 Convert Customer Cost to Credits (1 Credit = $0.001)
    const creditsUsed = Math.ceil(customerCost / CREDIT_VALUE_USD);

    // 3. Perform atomic updates and logging in a transaction
    await prisma.$transaction([
      // A. Update Daily Aggregates
      prisma.aiUsageStat.upsert({
        where: {
          userId_businessProfileId_date_modelName: {
            userId,
            businessProfileId: businessProfileId || 0,
            date: today,
            modelName,
          },
        },
        update: {
          promptTokens: { increment: promptTokens },
          completionTokens: { increment: completionTokens },
          embeddingTokens: { increment: embeddingTokens },
          totalTokens: { increment: totalTokens },
          apiCalls: { increment: 1 },
          groundingCalls: { increment: groundingCalls },
          systemCost: { increment: systemCost },
          customerCost: { increment: customerCost },
        },
        create: {
          userId,
          businessProfileId: businessProfileId || 0,
          date: today,
          modelName,
          promptTokens,
          completionTokens,
          embeddingTokens,
          totalTokens,
          apiCalls: 1,
          groundingCalls,
          systemCost,
          customerCost,
          multiplier,
        },
      }),

      // B. Create Granular Call Log
      prisma.aiCallLog.create({
        data: {
          userId,
          businessProfileId: businessProfileId || 0,
          conversationId,
          modelName,
          operation: operation || "generic",
          promptTokens,
          completionTokens,
          embeddingTokens,
          groundingCalls,
          systemCost,
          customerCost,
          multiplier,
        },
      }),

      // C. Update total usage (Credits) on BusinessProfile
      ...(businessProfileId
        ? [
            prisma.businessProfile.update({
              where: { id: businessProfileId },
              data: {
                monthlyCreditsUsed: { increment: creditsUsed },
                monthlyTokensUsed: { increment: totalTokens },
              },
            }),
          ]
        : []),

      // D. Update total usage on User (global quota enforcement)
      prisma.user.update({
        where: { id: userId },
        data: {
          monthlyCreditsUsed: { increment: creditsUsed },
          monthlyTokensUsed: { increment: totalTokens },
        },
      }),
    ]);

    logger.debug("billing.record_usage_success", {
      businessProfileId,
      modelName,
      systemCost,
      customerCost,
    });

    // Notify Frontend to refresh credits in real-time
    const { syncCreditsUpdate } = await import("./socketSync.service");
    syncCreditsUpdate({
      businessProfileId: businessProfileId || 0,
      userId,
      creditsUsed,
      totalCreditsUsed: (await prisma.user.findUnique({ where: { id: userId }, select: { monthlyCreditsUsed: true } }))?.monthlyCreditsUsed || 0
    });
  } catch (error: any) {
    logger.error("billing.record_usage_failure.dead_lettering", {
      error: error.message,
      businessProfileId,
      modelName,
    });

    // Dead-letter: Save to separate table for manual reconciliation
    await prisma.billingFailureLog
      .create({
        data: {
          userId,
          businessProfileId: businessProfileId || 0,
          modelName,
          promptTokens,
          completionTokens,
          embeddingTokens,
          groundingCalls,
          error: error instanceof Error ? error.message : String(error),
          operation,
        },
      })
      .catch((innerErr) => {
        logger.error("billing.dead_letter_failure_CRITICAL", {
          error: innerErr.message,
        });
      });
  }
}
