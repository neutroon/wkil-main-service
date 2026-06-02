import bcrypt from "bcrypt";
import { Prisma } from "@prisma/client";
import prisma from "@config/prisma";
import {
  generateAccessToken,
  generateRefreshToken,
} from "@modules/auth/core/auth.middleware";
import { getBillingMultiplier } from "@modules/settings/settings.service";
import { clearQuotaCache } from "@modules/billing/billing.service";
import { generateRandomToken, hashToken } from "@modules/auth/core/tokenCrypto";
import { sendVerificationEmail } from "@modules/mail/mail.service";
import { AppError } from "@middlewares/errorHandler.middleware";

export const createUser = async (
  name: string,
  email: string,
  password: string,
  role: string = "user",
) => {
  const normalizedEmail = email.toLowerCase();
  const hashed = await bcrypt.hash(password, 10);

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail },
  });
  if (existingUser) {
    throw new AppError("User already exists", 409);
  }

  // Generate verification token (unhashed for email, hashed for DB)
  const verificationToken = generateRandomToken();
  const hashedVerificationToken = hashToken(verificationToken);

  const user = await prisma.user.create({
    data: {
      name,
      email: normalizedEmail,
      password: hashed,
      role: role as "user" | "admin" | "manager" | "super_admin",
      isEmailVerified: false,
      emailVerificationToken: hashedVerificationToken,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isEmailVerified: true,
      lastVerificationSentAt: true,
      isBusinessProfileCreated: true,
      createdAt: true,
    },
  });

  // Send verification email asynchronously
  sendVerificationEmail(user.email, user.name, verificationToken).catch(
    (err) => {
      // We log but don't fail the registration if the email fails (user can resend later)
      const { logger } = require("@utils/logger");
      logger.error("Registration email dispatch failed", {
        userId: user.id,
        error: err,
      });
    },
  );

  return user;
};

export const loginUser = async (email: string, password: string) => {
  const normalizedEmail = email.toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    select: {
      id: true,
      name: true,
      email: true,
      password: true,
      role: true,
      isEmailVerified: true,
      lastVerificationSentAt: true,
      isBusinessProfileCreated: true,
    },
  });

  if (!user) {
    throw new AppError("User not found", 404);
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    throw new AppError("Invalid credentials", 401);
  }

  // Generate tokens
  const accessToken = generateAccessToken({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  });

  const refreshToken = generateRefreshToken({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  });

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    isEmailVerified: user.isEmailVerified,
    lastVerificationSentAt: user.lastVerificationSentAt,
    isBusinessProfileCreated: user.isBusinessProfileCreated,
    accessToken,
    refreshToken,
  };
};

export const getUserById = async (
  id: number,
  includeInactive: boolean = false,
) => {
  const user = await prisma.user.findFirst({
    where: includeInactive ? { id } : { id, isActive: true },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      plan: true,
      isEmailVerified: true,
      lastVerificationSentAt: true,
      isBusinessProfileCreated: true,
      monthlyCreditsUsed: true,
      monthlyCreditQuota: true,
      isActive: true,
      deletedAt: true,
      createdAt: true,
      updatedAt: true,
      facebookAccounts: {
        select: {
          id: true,
          facebookUserId: true,
          name: true,
          pictureUrl: true,
          isActive: true,
          pages: {
            select: {
              id: true,
              pageId: true,
              pageName: true,
              category: true,
              pictureUrl: true,
              followersCount: true,
              isActive: true,
              businessProfileId: true,
            },
          },
          _count: {
            select: { activities: true },
          },
        },
      },
      businessProfiles: {
        select: {
          id: true,
          name: true,
          handoffEnabled: true,
          plan: true,
          monthlyTokensUsed: true,
          monthlyCreditsUsed: true,
          monthlyCreditQuota: true,
          brandKitCompleted: true,
          createdAt: true,
        },
      },
      socialIdentities: {
        select: { avatarUrl: true },
        orderBy: { updatedAt: "desc" },
        take: 1,
      },
      _count: {
        select: { businessProfiles: true },
      },
    },
  });

  if (!user) return null;

  const { socialIdentities, ...safeUser } = user;
  return {
    ...safeUser,
    avatar: socialIdentities.find((identity) => identity.avatarUrl)?.avatarUrl ?? undefined,
  };
};

export const updateCurrentUserProfile = async (
  id: number,
  input: { name?: string; email?: string; avatar?: string },
) => {
  const existing = await prisma.user.findFirst({
    where: { id, isActive: true },
    select: { id: true, email: true },
  });

  if (!existing) {
    throw new AppError("User not found", 404, true, "USER_NOT_FOUND");
  }

  if (
    input.email !== undefined &&
    input.email.toLowerCase() !== existing.email.toLowerCase()
  ) {
    throw new AppError(
      "Email address cannot be changed from this endpoint",
      400,
      true,
      "EMAIL_CHANGE_DISABLED",
    );
  }

  const data: Prisma.UserUpdateInput = {};
  if (input.name !== undefined) {
    data.name = input.name.trim();
  }

  if (Object.keys(data).length > 0) {
    await prisma.user.update({
      where: { id },
      data,
    });
  }

  return getUserById(id);
};

export const changeUserPassword = async (
  id: number,
  currentPassword: string,
  newPassword: string,
) => {
  const user = await prisma.user.findFirst({
    where: { id, isActive: true },
    select: {
      id: true,
      password: true,
    },
  });

  if (!user) {
    throw new AppError("User not found", 404, true, "USER_NOT_FOUND");
  }

  const currentPasswordMatches = await bcrypt.compare(
    currentPassword,
    user.password,
  );
  if (!currentPasswordMatches) {
    throw new AppError(
      "Current password is incorrect",
      401,
      true,
      "INVALID_CURRENT_PASSWORD",
    );
  }

  const passwordUnchanged = await bcrypt.compare(newPassword, user.password);
  if (passwordUnchanged) {
    throw new AppError(
      "New password must be different from the current password",
      400,
      true,
      "PASSWORD_UNCHANGED",
    );
  }

  await prisma.user.update({
    where: { id },
    data: { password: await bcrypt.hash(newPassword, 10) },
  });

  return getUserById(id);
};

export const deactivateCurrentUser = async (id: number) => {
  return prisma.user.update({
    where: { id },
    data: {
      isActive: false,
      deletedAt: new Date(),
      refreshTokenHash: null,
      previousRefreshTokenHash: null,
      refreshTokenExpiresAt: null,
      rotatedAt: null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      deletedAt: true,
      updatedAt: true,
    },
  });
};

export const getAllUsers = async (includeInactive: boolean = false) => {
  return prisma.user.findMany({
    where: includeInactive ? {} : { isActive: true },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      plan: true,
      monthlyQuota: true,
      monthlyTokensUsed: true,
      monthlyCreditQuota: true,
      monthlyCreditsUsed: true,
      isActive: true,
      isEmailVerified: true,
      lastVerificationSentAt: true,
      isBusinessProfileCreated: true,
      deletedAt: true,
      createdAt: true,
      updatedAt: true,
      businessProfiles: {
        select: {
          id: true,
          name: true,
          plan: true,
          monthlyTokensUsed: true,
          monthlyCreditsUsed: true,
          monthlyCreditQuota: true,
          createdAt: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
};

export const updateUserRole = async (
  id: number,
  role: string,
  name: string,
  email: string,
  plan?: string,
  monthlyQuota?: number,
  monthlyCreditQuota?: number,
) => {
  return await prisma.$transaction(async (tx) => {
    // 1. Update User basic info
    const user = await tx.user.update({
      where: { id },
      data: {
        role: role as "user" | "admin" | "manager" | "super_admin",
        name,
        // email: email, // Disabled for production identity stability
        plan,
        monthlyQuota,
        monthlyCreditQuota,
      },
      select: {
        id: true,
        name: true,
        email: true,
        facebookAccounts: true,
        analytics: true,
        role: true,
        plan: true,
        isEmailVerified: true,
        lastVerificationSentAt: true,
        monthlyQuota: true,
        monthlyCreditQuota: true,
        monthlyCreditsUsed: true,
        isBusinessProfileCreated: true,
        updatedAt: true,
        businessProfiles: {
          select: { id: true },
        },
      },
    });

    // Clear quota cache for instant enforcement
    clearQuotaCache(id);

    return user;
  });
};

export const deactivateUser = async (id: number) => {
  return prisma.user.update({
    where: { id },
    data: {
      isActive: false,
      deletedAt: new Date(),
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      deletedAt: true,
      updatedAt: true,
    },
  });
};

export const reactivateUser = async (id: number) => {
  return prisma.user.update({
    where: { id },
    data: {
      isActive: true,
      deletedAt: null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      deletedAt: true,
      updatedAt: true,
    },
  });
};

export const permanentlyDeleteUser = async (id: number) => {
  // First deactivate all related Facebook accounts
  await prisma.facebookAccount.updateMany({
    where: { userId: id },
    data: { isActive: false },
  });

  // Then delete the user (this will cascade to related records)
  return prisma.user.delete({
    where: { id },
  });
};

// Manager assignment functions

export const assignUserToManager = async (
  managerId: number,
  userId: number,
  assignedBy: number,
) => {
  // A manager assignment is strictly manager -> normal user.
  const manager = await prisma.user.findFirst({
    where: { id: managerId, isActive: true },
    select: { role: true },
  });

  if (!manager || manager.role !== "manager") {
    throw new AppError("Assigned manager must have the manager role", 400);
  }

  const user = await prisma.user.findFirst({
    where: { id: userId, isActive: true },
    select: { role: true },
  });

  if (!user) {
    throw new AppError("User not found or inactive", 404);
  }

  if (user.role !== "user") {
    throw new AppError("Only normal users can be assigned to managers", 400);
  }

  const existingAssignment = await prisma.userManagement.findFirst({
    where: { managerId, userId },
  });

  if (existingAssignment?.isActive) {
    throw new AppError("User is already assigned to this manager", 409);
  }

  if (existingAssignment) {
    return prisma.userManagement.update({
      where: { id: existingAssignment.id },
      data: {
        isActive: true,
        assignedBy,
        assignedAt: new Date(),
      },
      include: {
        manager: {
          select: { id: true, name: true, email: true, role: true },
        },
        user: {
          select: { id: true, name: true, email: true, role: true },
        },
        assigner: {
          select: { id: true, name: true, email: true, role: true },
        },
      },
    });
  }

  return prisma.userManagement.create({
    data: {
      managerId,
      userId,
      assignedBy,
    },
    include: {
      manager: {
        select: { id: true, name: true, email: true, role: true },
      },
      user: {
        select: { id: true, name: true, email: true, role: true },
      },
      assigner: {
        select: { id: true, name: true, email: true, role: true },
      },
    },
  });
};

export const getManagedUsers = async (managerId: number) => {
  return prisma.userManagement.findMany({
    where: {
      managerId,
      isActive: true,
      manager: { role: "manager" },
      user: { role: "user" },
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isEmailVerified: true,
          lastVerificationSentAt: true,
          isActive: true,
          deletedAt: true,
          createdAt: true,
          facebookAccounts: {
            where: { isActive: true },
            include: {
              pages: { where: { isActive: true } },
              _count: { select: { activities: true } },
            },
          },
          analytics: {
            orderBy: { date: "desc" },
            take: 30,
          },
          businessProfiles: {
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              name: true,
              plan: true,
              monthlyTokensUsed: true,
              monthlyCreditsUsed: true,
              monthlyCreditQuota: true,
              brandKitCompleted: true,
              createdAt: true,
            },
          },
        },
      },
    },
    orderBy: { assignedAt: "desc" },
  });
};

export const canManageUser = async (
  managerId: number,
  targetUserId: number,
): Promise<boolean> => {
  // Check if user is super admin or admin (can manage anyone)
  const manager = await prisma.user.findFirst({
    where: { id: managerId, isActive: true },
    select: { role: true },
  });

  if (!manager) return false;

  // Super admins and admins can manage anyone
  if (["super_admin", "admin"].includes(manager.role)) {
    return true;
  }

  // Managers can only manage assigned users
  if (manager.role === "manager") {
    const relationship = await prisma.userManagement.findFirst({
      where: {
        managerId,
        userId: targetUserId,
        isActive: true,
        user: { role: "user" },
      },
    });

    return !!relationship;
  }

  return false;
};

export const removeUserAssignment = async (
  assignmentId: number,
  removedBy: number,
) => {
  return prisma.userManagement.update({
    where: { id: assignmentId },
    data: {
      isActive: false,
      updatedAt: new Date(),
    },
    include: {
      manager: {
        select: { id: true, name: true, email: true },
      },
      user: {
        select: { id: true, name: true, email: true },
      },
    },
  });
};

export const getManagerDashboard = async (managerId: number) => {
  const managedUsers = await getManagedUsers(managerId);

  const totalManagedUsers = managedUsers.length;
  const activeUsers = managedUsers.filter((u) => u.user.isActive).length;
  const totalFacebookAccounts = managedUsers.reduce(
    (sum, u) => sum + u.user.facebookAccounts.length,
    0,
  );
  const totalPages = managedUsers.reduce(
    (sum, u) =>
      sum +
      u.user.facebookAccounts.reduce(
        (accSum, acc) => accSum + acc.pages.length,
        0,
      ),
    0,
  );

  // Get recent activities for managed users
  const userIds = managedUsers.map((u) => u.user.id);
  const recentActivities = await prisma.facebookActivity.findMany({
    where: {
      facebookAccount: {
        userId: { in: userIds },
      },
      createdAt: {
        gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // Last 7 days
      },
    },
    include: {
      facebookAccount: {
        include: {
          user: { select: { name: true, email: true } },
        },
      },
      facebookPage: { select: { pageName: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  // Get AI usage stats for all managed users business profiles
  const businessProfiles = await prisma.businessProfile.findMany({
    where: { userId: { in: userIds } },
    select: { id: true, userId: true },
  });

  const bpIds = businessProfiles.map((bp) => bp.id);
  const [aiUsage, aiMessageRows] = await Promise.all([
    prisma.aiUsageStat.groupBy({
      by: ["businessProfileId"],
      where: { businessProfileId: { in: bpIds } },
      _sum: {
        totalTokens: true,
        systemCost: true,
      },
    }),
    userIds.length > 0
      ? prisma.$queryRaw<
          Array<{ userId: number; status: string; count: number }>
        >(Prisma.sql`
          SELECT
            bp."userId" AS "userId",
            cm."status"::text AS "status",
            COUNT(*)::int AS "count"
          FROM "ConversationMessage" cm
          INNER JOIN "Conversation" c ON c."id" = cm."conversationId"
          INNER JOIN "BusinessProfile" bp ON bp."id" = c."businessProfileId"
          WHERE cm."role" = 'model'
            AND cm."status"::text IN ('SENT', 'DELIVERED', 'READ', 'FAILED')
            AND bp."userId" IN (${Prisma.join(userIds)})
          GROUP BY bp."userId", cm."status"::text
        `)
      : Promise.resolve([]),
  ]);

  const billingMultiplier = await getBillingMultiplier();

  // Create a map for quick lookup: userId -> { tokens: number, cost: number, systemCost: number, profit: number }
  const userAiStats: Record<
    number,
    { tokens: number; cost: number; systemCost: number; profit: number }
  > = {};
  businessProfiles.forEach((bp) => {
    const usage = aiUsage.find((u) => u.businessProfileId === bp.id);
    const tokens = usage?._sum.totalTokens || 0;
    const systemCost = usage?._sum.systemCost || 0;
    const revenue = systemCost * billingMultiplier;
    const profit = revenue - systemCost;

    if (!userAiStats[bp.userId]) {
      userAiStats[bp.userId] = { tokens: 0, cost: 0, systemCost: 0, profit: 0 };
    }
    userAiStats[bp.userId].tokens += tokens;
    userAiStats[bp.userId].cost += revenue;
    userAiStats[bp.userId].systemCost += systemCost;
    userAiStats[bp.userId].profit += profit;
  });

  const userAiMessageStats: Record<number, { sent: number; failed: number }> =
    {};
  aiMessageRows.forEach((row) => {
    if (!userAiMessageStats[row.userId]) {
      userAiMessageStats[row.userId] = { sent: 0, failed: 0 };
    }

    if (row.status === "FAILED") {
      userAiMessageStats[row.userId].failed += Number(row.count);
    } else {
      userAiMessageStats[row.userId].sent += Number(row.count);
    }
  });

  const aiMessagesSent = Object.values(userAiMessageStats).reduce(
    (sum, stats) => sum + stats.sent,
    0,
  );
  const aiMessagesFailed = Object.values(userAiMessageStats).reduce(
    (sum, stats) => sum + stats.failed,
    0,
  );

  return {
    totalManagedUsers,
    activeUsers,
    inactiveUsers: totalManagedUsers - activeUsers,
    totalFacebookAccounts,
    totalPages,
    aiMessagesSent,
    aiMessagesFailed,
    recentActivities,
    userPerformance: managedUsers.map((u) => ({
      userId: u.user.id,
      userName: u.user.name,
      userEmail: u.user.email,
      isActive: u.user.isActive,
      facebookAccounts: u.user.facebookAccounts.length,
      totalPages: u.user.facebookAccounts.reduce(
        (sum, acc) => sum + acc.pages.length,
        0,
      ),
      totalActivities: u.user.facebookAccounts.reduce(
        (sum, acc) => sum + acc._count.activities,
        0,
      ),
      aiMessagesSent: userAiMessageStats[u.user.id]?.sent || 0,
      aiMessagesFailed: userAiMessageStats[u.user.id]?.failed || 0,
      recentAnalytics: u.user.analytics.slice(0, 7), // Last 7 days
      aiStats: userAiStats[u.user.id] || { tokens: 0, cost: 0 },
    })),
  };
};

export const getAllUserAssignments = async () => {
  return prisma.userManagement.findMany({
    where: {
      isActive: true,
      manager: { role: "manager" },
      user: { role: "user" },
    },
    include: {
      manager: {
        select: { id: true, name: true, email: true, role: true },
      },
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          isActive: true,
        },
      },
      assigner: {
        select: { id: true, name: true, email: true, role: true },
      },
    },
    orderBy: { assignedAt: "desc" },
  });
};

export const getUserAnalytics = async (userId: number, days: number = 30) => {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  return prisma.userAnalytics.findMany({
    where: { userId, date: { gte: startDate } },
    orderBy: { date: "desc" },
    take: days,
  });
};

export const getAccessibleProfileIds = async (
  userId: number,
): Promise<number[]> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });

  if (!user) return [];

  // Super admins and admins see ALL profiles
  if (["super_admin", "admin"].includes(user.role)) {
    const allProfiles = await prisma.businessProfile.findMany({
      select: { id: true },
    });
    return allProfiles.map((p) => p.id);
  }

  // Managers see their own AND their managed users' profiles
  if (user.role === "manager") {
    const managedUsers = await prisma.userManagement.findMany({
      where: {
        managerId: userId,
        isActive: true,
        manager: { role: "manager" },
        user: { role: "user" },
      },
      select: { userId: true },
    });

    const userIds = [userId, ...managedUsers.map((m) => m.userId)];

    const profiles = await prisma.businessProfile.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    });

    return profiles.map((p) => p.id);
  }

  // Regular users see only their own
  const profiles = await prisma.businessProfile.findMany({
    where: { userId },
    select: { id: true },
  });

  return profiles.map((p) => p.id);
};
