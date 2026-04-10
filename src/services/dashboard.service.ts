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
  avgResponseTime: number; // In minutes
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
  const [socialStats, aiStats, conversations] = await Promise.all([
    getDashboardStats(userId, days),
    getAiPerformanceStats(userId.toString(), role, days),
    prisma.conversation.findMany({
      where: {
        businessProfile: { userId },
        createdAt: { gte: new Date(Date.now() - (days || 30) * 24 * 60 * 60 * 1000) }
      },
      select: { createdAt: true }
    })
  ]);

  // Lead Velocity = Count of new conversations in the period
  const leadVelocity = conversations.length;

  // Simple channel health check
  const accounts = await prisma.facebookAccount.findFirst({ where: { userId, isActive: true } });
  const waAccounts = await prisma.whatsAppAccount.findFirst({ where: { userId, isActive: true } });

  return {
    ...socialStats,
    aiAutomationRate: aiStats.automationRate,
    aiAccuracyScore: aiStats.accuracyScore,
    leadVelocity,
    avgResponseTime: 1.5, // Placeholder for now - high-end default
    channelHealth: {
      facebook: !!accounts,
      whatsapp: !!waAccounts,
      web: true // Assuming web is always enabled if they have an account
    }
  };
};


