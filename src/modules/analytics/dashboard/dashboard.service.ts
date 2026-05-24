import prisma, { Prisma } from "@config/prisma";
import { getAiPerformanceStats } from "../ai/analytics.service";

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

type SetupProgressStepKey = "profile" | "channels" | "inbox" | "enable";
type SetupProgressEvent = "INBOX_OPENED" | "AGENT_CONFIGURED";

interface SetupProgressStep {
  key: SetupProgressStepKey;
  complete: boolean;
  available: boolean;
  href: string;
  completedAt: Date | null;
}

interface SetupProgress {
  complete: boolean;
  currentStep: SetupProgressStepKey | "done";
  steps: Record<SetupProgressStepKey, SetupProgressStep>;
  connectedChannels: {
    facebook: boolean;
    whatsapp: boolean;
    web: boolean;
  };
  signals: {
    businessProfileId: number | null;
    inboxOpenedAt: Date | null;
    agentConfiguredAt: Date | null;
    hasConversation: boolean;
    agentReady: boolean;
  };
}

export interface UnifiedDashboardResponse extends DashboardStatsResponse {
  aiAutomationRate: number;
  aiAccuracyScore: number;
  leadVelocity: number;
  avgResponseTime: number; // AI-only Average in minutes
  channelHealth: {
    facebook: boolean;
    whatsapp: boolean;
    web: boolean;
  };
  setupProgress: SetupProgress;
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

export const getSetupProgress = async (
  userId: number
): Promise<SetupProgress> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      isBusinessProfileCreated: true,
      setupInboxOpenedAt: true,
      setupAgentConfiguredAt: true,
    },
  });

  const profiles = await prisma.businessProfile.findMany({
    where: { userId },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  const profileIds = profiles.map((profile) => profile.id);
  const primaryProfile = profiles[0] ?? null;
  const profileComplete =
    Boolean(user?.isBusinessProfileCreated) || profileIds.length > 0;

  const [
    facebookPage,
    whatsAppAccount,
    widgetInstall,
    anyConversation,
    readConversation,
    activeAiConversation,
    autoDmPage,
  ] = profileIds.length
    ? await Promise.all([
        prisma.facebookPage.findFirst({
          where: {
            businessProfileId: { in: profileIds },
            isActive: true,
            facebookAccount: { isActive: true },
          },
          select: { id: true },
        }),
        prisma.whatsAppAccount.findFirst({
          where: {
            businessProfileId: { in: profileIds },
            isActive: true,
          },
          select: { id: true },
        }),
        prisma.widgetInstall.findFirst({
          where: {
            businessProfileId: { in: profileIds },
            isActive: true,
          },
          select: { id: true },
        }),
        prisma.conversation.findFirst({
          where: { businessProfileId: { in: profileIds } },
          select: { id: true },
        }),
        prisma.conversation.findFirst({
          where: {
            businessProfileId: { in: profileIds },
            readAt: { not: null },
          },
          select: { id: true },
        }),
        prisma.conversation.findFirst({
          where: {
            businessProfileId: { in: profileIds },
            aiEnabled: true,
          },
          select: { id: true },
        }),
        prisma.facebookPage.findFirst({
          where: {
            businessProfileId: { in: profileIds },
            isActive: true,
            commentAutoDmEnabled: true,
          },
          select: { id: true },
        }),
      ])
    : [null, null, null, null, null, null, null];

  const connectedChannels = {
    facebook: Boolean(facebookPage),
    whatsapp: Boolean(whatsAppAccount),
    web: Boolean(widgetInstall),
  };
  const channelsComplete =
    connectedChannels.facebook ||
    connectedChannels.whatsapp ||
    connectedChannels.web;
  const inboxComplete =
    Boolean(user?.setupInboxOpenedAt) || Boolean(readConversation) || Boolean(anyConversation);
  const agentReady =
    channelsComplete ||
    Boolean(activeAiConversation) ||
    Boolean(autoDmPage) ||
    Boolean(user?.setupAgentConfiguredAt);
  const enableComplete = inboxComplete && agentReady;

  const steps: SetupProgress["steps"] = {
    profile: {
      key: "profile",
      complete: profileComplete,
      available: true,
      href: profileComplete ? "/user/agent-setup" : "/user/onboarding",
      completedAt: profileComplete ? primaryProfile?.createdAt ?? null : null,
    },
    channels: {
      key: "channels",
      complete: channelsComplete,
      available: profileComplete,
      href: "/user/channels",
      completedAt: channelsComplete ? null : null,
    },
    inbox: {
      key: "inbox",
      complete: inboxComplete,
      available: channelsComplete,
      href: "/user/inbox",
      completedAt: user?.setupInboxOpenedAt ?? null,
    },
    enable: {
      key: "enable",
      complete: enableComplete,
      available: inboxComplete,
      href: Boolean(activeAiConversation) ? "/user/inbox" : "/user/channels",
      completedAt: enableComplete ? user?.setupAgentConfiguredAt ?? null : null,
    },
  };
  const currentStep =
    (Object.values(steps).find((step) => step.available && !step.complete)
      ?.key as SetupProgressStepKey | undefined) ??
    (Object.values(steps).find((step) => !step.complete)
      ?.key as SetupProgressStepKey | undefined) ??
    "done";

  return {
    complete: currentStep === "done",
    currentStep,
    steps,
    connectedChannels,
    signals: {
      businessProfileId: primaryProfile?.id ?? null,
      inboxOpenedAt: user?.setupInboxOpenedAt ?? null,
      agentConfiguredAt: user?.setupAgentConfiguredAt ?? null,
      hasConversation: Boolean(anyConversation),
      agentReady,
    },
  };
};

export const recordSetupProgressEvent = async (
  userId: number,
  event: SetupProgressEvent
): Promise<SetupProgress> => {
  const timestamp = new Date();

  if (event === "INBOX_OPENED") {
    await prisma.user.updateMany({
      where: { id: userId, setupInboxOpenedAt: null },
      data: { setupInboxOpenedAt: timestamp },
    });
  }

  if (event === "AGENT_CONFIGURED") {
    await prisma.user.updateMany({
      where: { id: userId, setupAgentConfiguredAt: null },
      data: { setupAgentConfiguredAt: timestamp },
    });
  }

  return getSetupProgress(userId);
};

export const getUnifiedDashboardStats = async (
  userId: number,
  role: string,
  days: number = DEFAULT_STATS_DAYS
): Promise<UnifiedDashboardResponse> => {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days || 30));

  const [socialStats, aiStats, conversations, messages, setupProgress] = await Promise.all([
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
        // We only care about user and delivered model messages for response time
        OR: [
          { role: "user" },
          { role: "model", status: { in: ["SENT", "DELIVERED", "READ"] } }
        ]
      },
      select: {
        conversationId: true,
        role: true,
        status: true,
        createdAt: true
      },
      orderBy: { createdAt: "asc" }
    }),
    getSetupProgress(userId),
  ]);

  // Lead Velocity = Count of new conversations in the period
  const leadVelocity = conversations.length;

  // --- Start AI Response Time Analysis ---
  const userStartTimes = new Map<number, Date>();
  const aiSamples: number[] = [];

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

        // Industry standard: Only count fully autonomous responses in AI Speed metrics
        if (msg.status === "SENT") {
          aiSamples.push(diffMinutes);
        }
        
        // Always reset after any AI interaction to keep the next benchmark clean.
        userStartTimes.delete(cid);
      }
    } else if (msg.role === "agent") {
      // If a human agent steps in, clear the timer. 
      // The AI's next speed sample will start from the user's next message.
      userStartTimes.delete(cid);
    }
  }

  const aiAvg = aiSamples.length > 0 
    ? aiSamples.reduce((a, b) => a + b, 0) / aiSamples.length 
    : 0;
  // --- End AI Response Time Analysis ---

  return {
    ...socialStats,
    aiAutomationRate: aiStats.automationRate,
    aiAccuracyScore: aiStats.accuracyScore,
    leadVelocity,
    avgResponseTime: parseFloat(aiAvg.toFixed(2)),
    channelHealth: {
      facebook: setupProgress.connectedChannels.facebook,
      whatsapp: setupProgress.connectedChannels.whatsapp,
      web: setupProgress.connectedChannels.web,
    },
    setupProgress,
  };
};







