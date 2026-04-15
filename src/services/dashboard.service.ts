import prisma, { Prisma } from "../config/prisma";
import { getAiPerformanceStats } from "./aiAnalytics.service";

interface DashboardActivityItem {
  id: number;
  type: string;
  createdAt: Date;
  success: boolean;
  errorMessage: string | null;
  metadata: Prisma.JsonValue | null;
  account: {
    id: number;
    facebookUserId: string | null;
  };
  page: {
    id: number;
    externalPageId: string;
    name: string;
  } | null;
}

interface DashboardActivityResponse {
  hasConnectedAccounts: boolean;
  totalConnectedAccounts: number;
  items: DashboardActivityItem[];
  emptyStateMessage: string | null;
}

interface DashboardStatsResponse {
  hasConnectedAccounts: boolean;
  connectedAccounts: number;
  connectedPages: number;
  postsCreated: number;
  postsScheduled: number;
  commentsReplied: number;
  totalReach: number;
  periodDays: number;
  lastUpdated: Date | null;
  recentPerformance: {
    date: Date;
    postsCreated: number;
    postsScheduled: number;
    totalEngagement: number;
  }[];
}

export interface UnifiedDashboardResponse extends DashboardStatsResponse {
  aiAutomationRate: number;
  aiAccuracyScore: number;
  leadVelocity: number;
  avgResponseTime: number; // Total Average
  aiAvgResponseTime: number; // AI-only Average
  humanAvgResponseTime: number; // Human-only Average
  channelHealth: {
    facebook: boolean;
    whatsapp: boolean;
    web: boolean;
  };
}

const DEFAULT_ACTIVITY_LIMIT = 15;
const DEFAULT_STATS_DAYS = 30;

export const getDashboardActivity = async (
  userId: number,
  limit: number = DEFAULT_ACTIVITY_LIMIT
): Promise<DashboardActivityResponse> => {
  const [accounts, activities] = await Promise.all([
    prisma.facebookAccount.findMany({
      where: { userId, isActive: true },
      select: { id: true },
    }),
    prisma.facebookActivity.findMany({
      where: {
        facebookAccount: {
          userId,
        },
      },
      include: {
        facebookAccount: {
          select: {
            id: true,
            facebookUserId: true,
          },
        },
        facebookPage: {
          select: {
            id: true,
            pageId: true,
            pageName: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
  ]);

  const hasConnectedAccounts = accounts.length > 0;

  const items: DashboardActivityItem[] = activities.map((activity) => ({
    id: activity.id,
    type: activity.activityType,
    createdAt: activity.createdAt,
    success: activity.success,
    errorMessage: activity.errorMessage,
    metadata: activity.activityData,
    account: {
      id: activity.facebookAccount?.id || activity.facebookAccountId,
      facebookUserId: activity.facebookAccount?.facebookUserId || null,
    },
    page: activity.facebookPage
      ? {
          id: activity.facebookPage.id,
          externalPageId: activity.facebookPage.pageId,
          name: activity.facebookPage.pageName,
        }
      : null,
  }));

  let emptyStateMessage: string | null = null;
  if (!hasConnectedAccounts) {
    emptyStateMessage = "Start by connecting your accounts";
  } else if (items.length === 0) {
    emptyStateMessage = "No recent activity";
  }

  return {
    hasConnectedAccounts,
    totalConnectedAccounts: accounts.length,
    items,
    emptyStateMessage,
  };
};

export const getDashboardStats = async (
  userId: number,
  days: number = DEFAULT_STATS_DAYS
): Promise<DashboardStatsResponse> => {
  const periodDays = days > 0 ? days : DEFAULT_STATS_DAYS;
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - periodDays);

  const [accounts, analytics] = await Promise.all([
    prisma.facebookAccount.findMany({
      where: { userId, isActive: true },
      include: {
        pages: {
          where: { isActive: true },
          select: { id: true },
        },
      },
    }),
    prisma.userAnalytics.findMany({
      where: { userId, date: { gte: startDate } },
      orderBy: { date: "desc" },
    }),
  ]);

  const connectedAccounts = accounts.length;
  const hasConnectedAccounts = connectedAccounts > 0;
  const connectedPages = accounts.reduce(
    (sum, account) => sum + account.pages.length,
    0
  );

  const aggregated = analytics.reduce(
    (acc, entry) => {
      acc.postsCreated += entry.postsCreated;
      acc.postsScheduled += entry.postsScheduled;
      acc.commentsReplied += entry.commentsReplied;
      acc.totalReach += entry.totalEngagement;
      return acc;
    },
    {
      postsCreated: 0,
      postsScheduled: 0,
      commentsReplied: 0,
      totalReach: 0,
    }
  );

  const recentPerformance = analytics
    .slice(0, Math.min(14, analytics.length))
    .map((entry) => ({
      date: entry.date,
      postsCreated: entry.postsCreated,
      postsScheduled: entry.postsScheduled,
      totalEngagement: entry.totalEngagement,
    }))
    .reverse();

  return {
    hasConnectedAccounts,
    connectedAccounts,
    connectedPages,
    postsCreated: aggregated.postsCreated,
    postsScheduled: aggregated.postsScheduled,
    commentsReplied: aggregated.commentsReplied,
    totalReach: aggregated.totalReach,
    periodDays,
    lastUpdated: analytics.length > 0 ? analytics[0].date : null,
    recentPerformance,
  };
};

export const getUnifiedDashboardStats = async (
  userId: number,
  role: string,
  days: number = DEFAULT_STATS_DAYS
): Promise<UnifiedDashboardResponse> => {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days || 30));

  const [socialStats, aiStats, conversations, messages] = await Promise.all([
    getDashboardStats(userId, days),
    getAiPerformanceStats(userId.toString(), role, days),
    prisma.conversation.findMany({
      where: {
        businessProfile: { userId },
        createdAt: { gte: startDate }
      },
      select: { createdAt: true }
    }),
    prisma.conversationMessage.findMany({
      where: {
        conversation: {
          businessProfile: { userId },
          NOT: { channel: "facebook_comment" }
        },
        createdAt: { gte: startDate },
        // We only care about user and sent model messages for response time
        OR: [
          { role: "user" },
          { role: "model", status: { in: ["SENT", "EDITED_AND_SENT"] } }
        ]
      },
      select: {
        conversationId: true,
        role: true,
        status: true,
        createdAt: true
      },
      orderBy: { createdAt: "asc" }
    })
  ]);

  // Lead Velocity = Count of new conversations in the period
  const leadVelocity = conversations.length;

  // --- Start Response Time Analysis ---
  const userStartTimes = new Map<number, Date>();
  const aiSamples: number[] = [];
  const humanSamples: number[] = [];

  for (const msg of messages) {
    const cid = msg.conversationId;
    if (msg.role === "user") {
      // If we're already tracking a wait start for this conversation, don't update it
      // (Industry practice: measure from the FIRST message in a sequence)
      if (!userStartTimes.has(cid)) {
        userStartTimes.set(cid, msg.createdAt);
      }
    } else if (msg.role === "model") {
      const startTime = userStartTimes.get(cid);
      if (startTime) {
        const diffMinutes = Math.max(0, (msg.createdAt.getTime() - startTime.getTime()) / (1000 * 60));

        if (msg.status === "SENT") {
          aiSamples.push(diffMinutes);
        } else if (msg.status === "EDITED_AND_SENT") {
          humanSamples.push(diffMinutes);
        }
        
        // Reset after a response is recorded
        userStartTimes.delete(cid);
      }
    }
  }

  const aiAvg = aiSamples.length > 0 
    ? aiSamples.reduce((a, b) => a + b, 0) / aiSamples.length 
    : 0;
  
  const humanAvg = humanSamples.length > 0 
    ? humanSamples.reduce((a, b) => a + b, 0) / humanSamples.length 
    : 0;

  const totalSamples = [...aiSamples, ...humanSamples];
  const overallAvg = totalSamples.length > 0 
    ? totalSamples.reduce((a, b) => a + b, 0) / totalSamples.length 
    : 0;
  // --- End Response Time Analysis ---

  // Simple channel health check
  const accounts = await prisma.facebookAccount.findFirst({ where: { userId, isActive: true } });
  const waAccounts = await prisma.whatsAppAccount.findFirst({ where: { userId, isActive: true } });

  return {
    ...socialStats,
    aiAutomationRate: aiStats.automationRate,
    aiAccuracyScore: aiStats.accuracyScore,
    leadVelocity,
    avgResponseTime: parseFloat(overallAvg.toFixed(2)),
    aiAvgResponseTime: parseFloat(aiAvg.toFixed(2)),
    humanAvgResponseTime: parseFloat(humanAvg.toFixed(2)),
    channelHealth: {
      facebook: !!accounts,
      whatsapp: !!waAccounts,
      web: true // Assuming web is always enabled if they have an account
    }
  };
};


