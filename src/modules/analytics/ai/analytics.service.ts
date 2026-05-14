import { getBillingMultiplier } from "@modules/settings/settings.service";
import prisma from "@config/prisma";

export interface AiPerformanceStats {
  automationRate: number;
  totalAiReplies: number;
  autoSentCount: number;
  needsReviewCount: number;
  handoffReasons: { category: string; count: number }[];
  accuracyScore: number; // 0 to 100
  dailyVolume: { date: string; count: number }[];
  totalTokensConsumed: number;
  estimatedCost: number; // For non-admins this is billed cost, for admins it is system cost or choice
  systemCost: number;
  revenue: number;
  profit: number;
  billingMultiplier: number;
  groundingCalls: number;
  embeddingTokens: number;
}

export async function getAiPerformanceStats(
  userIdStr: string,
  role: string,
  days = 30,
  businessProfileId?: number,
): Promise<AiPerformanceStats> {
  const userId = parseInt(userIdStr, 10);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // 1. Build where clause
  const baseWhere: any = {
    role: "model",
    createdAt: { gte: startDate },
    conversation: {
      businessProfile: {
        userId: userId,
      },
    },
  };

  if (businessProfileId) {
    baseWhere.conversation.businessProfileId = businessProfileId;
  }

  // 2. Aggregate status counts (Automation Rate)
  const statusCounts = await prisma.conversationMessage.groupBy({
    by: ["status"],
    where: baseWhere,
    _count: { _all: true },
  });

  const counts: Record<string, number> = {
    SENT: 0,
    DELIVERED: 0,
    READ: 0,
  };
  statusCounts.forEach((c) => {
    counts[c.status] = c._count._all;
  });

  const autoSentCount = counts["SENT"] + counts["DELIVERED"] + counts["READ"];
  const needsReviewCount = 0;
  const totalAiReplies = autoSentCount + needsReviewCount;
  const automationRate =
    totalAiReplies > 0 ? (autoSentCount / totalAiReplies) * 100 : 0;

  // 3. Handoff Reasons
  const reasonsGroup = await prisma.conversationMessage.groupBy({
    by: ["handoffCategory"],
    where: {
      ...baseWhere,
      handoffCategory: { not: null },
    },
    _count: { _all: true },
    orderBy: {
      _count: {
        handoffCategory: "desc",
      },
    },
  });

  const handoffReasons = reasonsGroup.map((rg) => ({
    category: rg.handoffCategory || "UNKNOWN",
    count: rg._count._all,
  }));

  const accuracyScore = 100;

  // 5. Daily Volume (Last 14 days)
  const volumeDate = new Date();
  volumeDate.setDate(volumeDate.getDate() - 14);

  const dailyMessages = await prisma.conversationMessage.findMany({
    where: {
      ...baseWhere,
      createdAt: { gte: volumeDate },
    },
    select: { createdAt: true },
  });

  const volumeMap: Record<string, number> = {};
  dailyMessages.forEach((m) => {
    const dateStr = m.createdAt.toISOString().split("T")[0];
    volumeMap[dateStr] = (volumeMap[dateStr] || 0) + 1;
  });

  const dailyVolume = Object.entries(volumeMap)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 6. Extract token consumption and system cost
  const usageStats = await prisma.aiUsageStat.aggregate({
    _sum: {
      totalTokens: true,
      systemCost: true,
      groundingCalls: true,
      embeddingTokens: true,
    },
    where: {
      businessProfile: { userId },
      date: { gte: startDate },
      ...(businessProfileId && { businessProfileId }),
    },
  });

  const totalTokensConsumed = usageStats._sum.totalTokens || 0;
  const actualSystemCost = usageStats._sum.systemCost || 0;
  const totalGroundingCalls = usageStats._sum.groundingCalls || 0;
  const totalEmbeddingTokens = usageStats._sum.embeddingTokens || 0;

  // 7. Calculate cost metrics using the stored production-grade system cost
  const multiplier = await getBillingMultiplier();
  const revenue = actualSystemCost * multiplier;
  const profit = revenue - actualSystemCost;

  // 8. Role-based data hardening: Scrub sensitive fields for non-admins
  const isAdmin = ["admin", "super_admin"].includes(role);

  return {
    automationRate,
    totalAiReplies,
    autoSentCount,
    needsReviewCount,
    handoffReasons,
    accuracyScore,
    dailyVolume,
    totalTokensConsumed,
    estimatedCost: revenue,
    systemCost: isAdmin ? actualSystemCost : 0,
    revenue: isAdmin ? revenue : 0,
    profit: isAdmin ? profit : 0,
    billingMultiplier: isAdmin ? multiplier : 0,
    groundingCalls: isAdmin ? totalGroundingCalls : 0,
    embeddingTokens: isAdmin ? totalEmbeddingTokens : 0,
  };
}





