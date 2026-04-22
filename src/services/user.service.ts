import bcrypt from "bcrypt";
import prisma from "../config/prisma";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../middlewares/auth.middleware";
import { getBillingMultiplier } from "./settings.service";
import { clearQuotaCache } from "./billing.service";

export const createUser = async (
  name: string,
  email: string,
  password: string,
  role: string = "user",
) => {
  const hashed = await bcrypt.hash(password, 10);

  // Check if user already exists
  const existingUser = await prisma.user.findUnique({ where: { email } });
  if (existingUser) {
    throw new Error("User already exists");
  }

  return prisma.user.create({
    data: {
      name,
      email,
      password: hashed,
      role: role as "user" | "admin" | "manager" | "super_admin",
    },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
    },
  });
};

export const loginUser = async (email: string, password: string) => {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true, email: true, password: true, role: true },
  });

  if (!user) {
    throw new Error("User not found");
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    throw new Error("Invalid credentials");
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
    accessToken,
    refreshToken,
  };
};

export const getUserById = async (
  id: number,
  includeInactive: boolean = false,
) => {
  return prisma.user.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      plan: true,
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
          responseMode: true,
          plan: true,
          monthlyCreditsUsed: true,
          brandKitCompleted: true,
          createdAt: true,
        },
      },
      _count: {
        select: { businessProfiles: true },
      },
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
      isActive: true,
      isBusinessProfileCreated: true,
      deletedAt: true,
      createdAt: true,
      updatedAt: true,
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
) => {
  return await prisma.$transaction(async (tx) => {
    // 1. Update User basic info
    const user = await tx.user.update({
      where: { id },
      data: {
        role: role as "user" | "admin" | "manager" | "super_admin",
        name,
        email,
        plan,
        monthlyQuota,
      },
      select: {
        id: true,
        name: true,
        email: true,
        facebookAccounts: true,
        analytics: true,
        role: true,
        plan: true,
        monthlyQuota: true,
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

// New hierarchical role management functions

export const assignUserToManager = async (
  managerId: number,
  userId: number,
  assignedBy: number,
) => {
  // Verify manager has appropriate role
  const manager = await prisma.user.findFirst({
    where: { id: managerId, isActive: true },
    select: { role: true },
  });

  if (!manager || !["super_admin", "admin", "manager"].includes(manager.role)) {
    throw new Error("Invalid manager role");
  }

  // Verify user exists and is active
  const user = await prisma.user.findFirst({
    where: { id: userId, isActive: true },
  });

  if (!user) {
    throw new Error("User not found or inactive");
  }

  // Check if assignment already exists
  const existingAssignment = await prisma.userManagement.findFirst({
    where: { managerId, userId, isActive: true },
  });

  if (existingAssignment) {
    throw new Error("User is already assigned to this manager");
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
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
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
        },
      },
    },
    orderBy: { assignedAt: "desc" },
  });
};

export const getManagerHierarchy = async (userId: number) => {
  return prisma.userManagement.findMany({
    where: {
      userId,
      isActive: true,
    },
    include: {
      manager: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
        },
      },
      assigner: {
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
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
    select: { id: true, userId: true }
  });
  
  const bpIds = businessProfiles.map(bp => bp.id);
  const aiUsage = await prisma.aiUsageStat.groupBy({
    by: ["businessProfileId"],
    where: { businessProfileId: { in: bpIds } },
    _sum: { 
      totalTokens: true,
      systemCost: true
    }
  });

  const billingMultiplier = await getBillingMultiplier();

  // Create a map for quick lookup: userId -> { tokens: number, cost: number, systemCost: number, profit: number }
  const userAiStats: Record<number, { tokens: number, cost: number, systemCost: number, profit: number }> = {};
  businessProfiles.forEach(bp => {
    const usage = aiUsage.find(u => u.businessProfileId === bp.id);
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

  return {
    totalManagedUsers,
    activeUsers,
    inactiveUsers: totalManagedUsers - activeUsers,
    totalFacebookAccounts,
    totalPages,
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
      recentAnalytics: u.user.analytics.slice(0, 7), // Last 7 days
      aiStats: userAiStats[u.user.id] || { tokens: 0, cost: 0 }
    })),
  };
};

export const getAllUserAssignments = async () => {
  return prisma.userManagement.findMany({
    where: { isActive: true },
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
