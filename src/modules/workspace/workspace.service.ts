import { Prisma } from "@prisma/client";
import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";

export const SKELETON_PROFILE_NAME = "My Business";
export const SKELETON_WORKSPACE_NAME = "My Workspace";

/**
 * Creates the tenant trio for a brand-new user inside the caller's
 * transaction: one workspace (1:1 with its profile), the skeleton
 * BusinessProfile awaiting chat/form onboarding, and the owner membership.
 * `isBusinessProfileCreated` stays false until setup completes.
 */
export async function provisionWorkspaceForUser(
  tx: Prisma.TransactionClient,
  userId: number,
  _ownerName: string,
): Promise<{ workspaceId: number; profileId: number }> {
  const workspace = await tx.workspace.create({
    data: { name: SKELETON_WORKSPACE_NAME },
  });
  const profile = await tx.businessProfile.create({
    data: {
      userId,
      workspaceId: workspace.id,
      name: SKELETON_PROFILE_NAME,
      setupCompletedAt: null,
    },
  });
  await tx.workspaceMember.create({
    data: { workspaceId: workspace.id, userId, role: "owner" },
  });
  return { workspaceId: workspace.id, profileId: profile.id };
}

async function getMemberProfileRows(userId: number) {
  return prisma.workspaceMember.findMany({
    where: { userId, isActive: true },
    include: { workspace: { include: { profile: { select: { id: true } } } } },
    orderBy: { workspaceId: "asc" },
  });
}

/**
 * Explicit active-profile resolution — the replacement for silent
 * "first profile" guessing. Precedence: explicit businessProfileId
 * (validated against memberships) → explicit activeWorkspaceId → the single
 * membership → ambiguity error.
 */
export async function getActiveProfileId(
  userId: number,
  businessProfileId?: number,
  activeWorkspaceId?: number,
): Promise<number> {
  const rows = await getMemberProfileRows(userId);
  const memberships = rows
    .map((r) => r.workspace?.profile)
    .filter((p): p is { id: number } => Boolean(p));

  if (businessProfileId) {
    if (!memberships.some((p) => p.id === businessProfileId)) {
      throw new AppError("Business profile not found.", 404);
    }
    return businessProfileId;
  }

  if (activeWorkspaceId) {
    const row = rows.find((r) => r.workspaceId === activeWorkspaceId);
    if (!row?.workspace?.profile) {
      throw new AppError("Business profile not found.", 404);
    }
    return row.workspace.profile.id;
  }

  if (memberships.length === 0) {
    throw new AppError("Business profile not found.", 404);
  }
  if (memberships.length > 1) {
    throw new AppError(
      "Multiple business profiles found — select one.",
      400,
    );
  }
  return memberships[0].id;
}
