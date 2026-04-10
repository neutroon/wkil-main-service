import prisma from "../config/prisma";

export interface AiPerformanceStats {
  automationRate: number;
  totalAiReplies: number;
  autoSentCount: number;
  needsReviewCount: number;
  handoffReasons: { category: string; count: number }[];
  accuracyScore: number; // 0 to 100
  dailyVolume: { date: string; count: number }[];
  totalTokensConsumed: number;
}

/**
 * Basic Jaccard Similarity for string comparison to score AI accuracy.
 * Comparing word sets is robust enough for a dashboard metric.
 */
function calculateSimilarity(str1: string, str2: string): number {
  const set1 = new Set(str1.toLowerCase().split(/\s+/));
  const set2 = new Set(str2.toLowerCase().split(/\s+/));
  const intersection = new Set([...set1].filter(x => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  if (union.size === 0) return 100;
  return (intersection.size / union.size) * 100;
}

export async function getAiPerformanceStats(userIdStr: string, role: string, days = 30, businessProfileId?: number): Promise<AiPerformanceStats> {
  const userId = parseInt(userIdStr, 10);
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  // 1. Build where clause
  const baseWhere: any = {
    role: "model",
    createdAt: { gte: startDate },
    conversation: {
      businessProfile: {
        userId: userId
      }
    }
  };

  if (businessProfileId) {
    baseWhere.conversation.businessProfileId = businessProfileId;
  }

  // 2. Aggregate status counts (Automation Rate)
  const statusCounts = await prisma.conversationMessage.groupBy({
    by: ["status"],
    where: baseWhere,
    _count: { _all: true }
  });

  const counts: Record<string, number> = { SENT: 0, PENDING_REVIEW: 0, EDITED_AND_SENT: 0 };
  statusCounts.forEach(c => {
    counts[c.status] = c._count._all;
  });

  const autoSentCount = counts["SENT"];
  const needsReviewCount = counts["PENDING_REVIEW"] + counts["EDITED_AND_SENT"];
  const totalAiReplies = autoSentCount + needsReviewCount;
  const automationRate = totalAiReplies > 0 ? (autoSentCount / totalAiReplies) * 100 : 0;

  // 3. Handoff Reasons
  const reasonsGroup = await prisma.conversationMessage.groupBy({
    by: ["handoffCategory"],
    where: {
      ...baseWhere,
      handoffCategory: { not: null }
    },
    _count: { _all: true },
    orderBy: {
      _count: {
        handoffCategory: 'desc'
      }
    }
  });

  const handoffReasons = reasonsGroup.map(rg => ({
    category: rg.handoffCategory || "UNKNOWN",
    count: rg._count._all
  }));

  // 4. Accuracy Score (Weighted average of similarity in corrections)
  const corrections = await prisma.aiCorrection.findMany({
    where: {
      message: {
        createdAt: { gte: startDate },
        conversation: { businessProfile: { userId } }
      }
    },
    select: {
      originalAiText: true,
      humanEditedText: true
    }
  });

  let totalSim = 0;
  corrections.forEach(c => {
    totalSim += calculateSimilarity(c.originalAiText, c.humanEditedText);
  });

  // If no corrections found, we assume 100% accuracy (or at least no recorded errors)
  const accuracyScore = corrections.length > 0 ? totalSim / corrections.length : 100;

  // 5. Daily Volume (Last 14 days)
  const volumeDate = new Date();
  volumeDate.setDate(volumeDate.getDate() - 14);
  
  const dailyMessages = await prisma.conversationMessage.findMany({
    where: {
      ...baseWhere,
      createdAt: { gte: volumeDate }
    },
    select: { createdAt: true }
  });

  const volumeMap: Record<string, number> = {};
  dailyMessages.forEach(m => {
    const dateStr = m.createdAt.toISOString().split("T")[0];
    volumeMap[dateStr] = (volumeMap[dateStr] || 0) + 1;
  });

  const dailyVolume = Object.entries(volumeMap).map(([date, count]) => ({ date, count })).sort((a,b) => a.date.localeCompare(b.date));

  const dailyVolume = Object.entries(volumeMap).map(([date, count]) => ({ date, count })).sort((a,b) => a.date.localeCompare(b.date));

  // 6. Extract token consumption (ADMINS ONLY)
  let totalTokensConsumed = 0;
  if (role === 'admin' || role === 'super_admin') {
    const usageStats = await prisma.aiUsageStat.aggregate({
      _sum: {
        totalTokens: true,
      },
      where: {
        businessProfile: { userId },
        date: { gte: startDate },
        ...(businessProfileId && { businessProfileId }),
      },
    });
    totalTokensConsumed = usageStats._sum.totalTokens || 0;
  }

  return {
    automationRate,
    totalAiReplies,
    autoSentCount,
    needsReviewCount,
    handoffReasons,
    accuracyScore,
    dailyVolume,
    totalTokensConsumed
  };
}

export async function getAiCorrections(userIdStr: string, limit = 50, offset = 0) {
  const userId = parseInt(userIdStr, 10);

  const rows = await prisma.aiCorrection.findMany({
    where: {
      message: {
        conversation: {
          businessProfile: { userId }
        }
      }
    },
    include: {
      message: {
        include: {
          conversation: true
        }
      }
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    skip: offset
  });

  return rows.map(r => {
    const similarity = calculateSimilarity(r.originalAiText, r.humanEditedText);
    
    // Normalise channel name for UI icons
    const channel = r.message.conversation.channel === "web" ? "webchat" : (r.message.conversation.channel || "webchat");
    
    // Improved customer name logic
    let customerName = r.message.conversation.customerPhone || r.message.conversation.senderId;
    if (channel === "webchat" && !r.message.conversation.customerPhone) {
      customerName = `Visitor #${r.message.conversation.id}`;
    }

    return {
      id: r.id,
      originalText: r.originalAiText,
      editedText: r.humanEditedText,
      similarity,
      channel,
      customerName,
      createdAt: r.createdAt
    };
  });
}
