import { Prisma } from "@prisma/client";
import { randomBytes } from "crypto";
import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";

export const SKELETON_PROFILE_NAME = "My Business";
export const SKELETON_WORKSPACE_NAME = "My Workspace";
export const WORKSPACE_MANAGER_ROLES = ["owner", "admin"] as const;

export async function requireWorkspaceProfileAccess(
  userId: number,
  businessProfileId: number,
  options: { manage?: boolean } = {},
): Promise<{ workspaceId: number; role: string }> {
  const profile = await prisma.businessProfile.findUnique({
    where: { id: businessProfileId },
    select: { workspaceId: true },
  });
  if (!profile) throw new AppError("Business profile not found.", 404);

  const membership = await prisma.workspaceMember.findUnique({
    where: {
      workspaceId_userId: { workspaceId: profile.workspaceId, userId },
    },
    select: { role: true, isActive: true },
  });
  if (!membership?.isActive) throw new AppError("Business profile not found.", 404);
  if (options.manage && !WORKSPACE_MANAGER_ROLES.includes(membership.role as "owner" | "admin")) {
    throw new AppError("Workspace owner or admin access required.", 403);
  }
  return { workspaceId: profile.workspaceId, role: membership.role };
}

export async function listWorkspacesForUser(
  userId: number,
): Promise<Array<{ workspaceId: number; profileId: number; name: string; role: string }>> {
  const memberships = await prisma.workspaceMember.findMany({
    where: { userId, isActive: true },
    include: {
      workspace: {
        select: { id: true, name: true, profile: { select: { id: true } } },
      },
    },
    orderBy: { workspaceId: "asc" },
  });

  return memberships
    .filter((m) => m.workspace?.profile)
    .map((m) => ({
      workspaceId: m.workspaceId,
      profileId: m.workspace!.profile!.id,
      name: m.workspace!.name,
      role: m.role,
    }));
}

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

export async function createWorkspace(
  userId: number,
  name: string,
): Promise<{ workspaceId: number; profileId: number }> {
  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: { name: name.trim() || SKELETON_WORKSPACE_NAME },
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
  });
}

export async function renameWorkspace(
  userId: number,
  workspaceId: number,
  name: string,
): Promise<void> {
  const member = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId, isActive: true, role: "owner" },
  });
  if (!member)
    throw new AppError("Only the workspace owner can rename it.", 403);

  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 100) {
    throw new AppError("Workspace name must be 1-100 characters.", 400);
  }

  await prisma.workspace.update({
    where: { id: workspaceId },
    data: { name: trimmed },
  });
}

export async function getWorkspace(
  userId: number,
  workspaceId: number,
): Promise<{ id: number; name: string }> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId, isActive: true },
  });
  if (!membership) throw new AppError("Access denied.", 403);

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new AppError("Workspace not found.", 404);

  return { id: workspace.id, name: workspace.name };
}

export async function listMembers(
  userId: number,
  workspaceId: number,
): Promise<
  Array<{
    id: number;
    userId: number;
    name: string;
    email: string;
    role: string;
    isActive: boolean;
    invitedAt: Date | null;
    createdAt: Date;
  }>
> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId, isActive: true },
  });
  if (!membership) throw new AppError("Access denied.", 403);

  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    include: { user: { select: { id: true, name: true, email: true } } },
    orderBy: [{ role: "asc" }, { createdAt: "asc" }],
  });

  return members.map((m) => ({
    id: m.id,
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email ?? "",
    role: m.role,
    isActive: m.isActive,
    invitedAt: m.invitedAt,
    createdAt: m.createdAt,
  }));
}

export async function inviteMember(
  userId: number,
  workspaceId: number,
  email: string,
  role: string = "member",
): Promise<{ token: string; expiresAt: Date }> {
  const membership = await prisma.workspaceMember.findFirst({
    where: {
      workspaceId,
      userId,
      isActive: true,
      role: { in: ["owner", "admin"] },
    },
  });
  if (!membership)
    throw new AppError(
      "Only owners and admins can invite members.",
      403,
    );

  const trimmed = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    throw new AppError("Invalid email address.", 400);
  }

  // Check if user is already a member
  const existingUser = await prisma.user.findUnique({
    where: { email: trimmed },
    select: { id: true },
  });
  if (existingUser) {
    const existingMember = await prisma.workspaceMember.findFirst({
      where: { workspaceId, userId: existingUser.id, isActive: true },
    });
    if (existingMember)
      throw new AppError("User is already a member.", 409);
  }

  // Check for pending invite
  const pendingInvite = await prisma.workspaceInvitation.findFirst({
    where: { workspaceId, email: trimmed, expiresAt: { gt: new Date() } },
  });
  if (pendingInvite)
    throw new AppError(
      "Invitation already pending for this email.",
      409,
    );

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await prisma.workspaceInvitation.create({
    data: {
      workspaceId,
      email: trimmed,
      role,
      token,
      invitedBy: userId,
      expiresAt,
    },
  });

  return { token, expiresAt };
}

export async function listInvitations(
  userId: number,
  workspaceId: number,
): Promise<
  Array<{
    id: number;
    email: string;
    role: string;
    token: string;
    expiresAt: Date;
    createdAt: Date;
  }>
> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId, isActive: true },
  });
  if (!membership) throw new AppError("Access denied.", 403);

  const invitations = await prisma.workspaceInvitation.findMany({
    where: { workspaceId, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });

  return invitations.map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    token: inv.token,
    expiresAt: inv.expiresAt,
    createdAt: inv.createdAt,
  }));
}

export async function getInviteInfoByToken(
  token: string,
): Promise<{
  id: number;
  workspaceId: number;
  workspaceName: string;
  email: string;
  role: string;
  invitedBy: number;
  inviterName: string | null;
  expiresAt: Date;
  createdAt: Date;
  isExpired?: boolean;
} | null> {
  const invitation = await prisma.workspaceInvitation.findUnique({
    where: { token },
    include: {
      workspace: {
        include: {
          profile: { select: { name: true } },
        },
      },
      inviter: { select: { name: true } },
    },
  });

  if (!invitation) return null;

  if (invitation.expiresAt < new Date()) {
    return {
      id: invitation.id,
      workspaceId: invitation.workspaceId,
      workspaceName: invitation.workspace?.profile?.name ?? "Workspace",
      email: invitation.email,
      role: invitation.role,
      invitedBy: invitation.invitedBy,
      inviterName: invitation.inviter?.name ?? null,
      expiresAt: invitation.expiresAt,
      createdAt: invitation.createdAt,
      isExpired: true,
    };
  }

  return {
    id: invitation.id,
    workspaceId: invitation.workspaceId,
    workspaceName: invitation.workspace?.profile?.name ?? "Workspace",
    email: invitation.email,
    role: invitation.role,
    invitedBy: invitation.invitedBy,
    inviterName: invitation.inviter?.name ?? null,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
  };
}

export async function deleteInvitation(
  userId: number,
  workspaceId: number,
  invitationId: number,
): Promise<void> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId, isActive: true, role: { in: ["owner", "admin"] } },
  });
  if (!membership) throw new AppError("Only owners and admins can revoke invitations.", 403);

  const invitation = await prisma.workspaceInvitation.findFirst({
    where: { id: invitationId, workspaceId },
  });
  if (!invitation) throw new AppError("Invitation not found.", 404);

  await prisma.workspaceInvitation.delete({ where: { id: invitationId } });
}

export async function acceptInvite(
  token: string,
  userId: number,
): Promise<{ workspaceId: number }> {
  const invitation = await prisma.workspaceInvitation.findUnique({
    where: { token },
  });

  if (!invitation) throw new AppError("Invalid invitation.", 404);
  if (invitation.expiresAt < new Date()) {
    throw new AppError("Invitation has expired.", 410);
  }

  // Check if user's email matches invitation
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  if (!user || (user.email ?? "").toLowerCase() !== invitation.email.toLowerCase()) {
    throw new AppError(
      "This invitation was sent to a different email address.",
      403,
    );
  }

  // Check if already a member
  const existing = await prisma.workspaceMember.findFirst({
    where: { workspaceId: invitation.workspaceId, userId, isActive: true },
  });
  if (existing)
    throw new AppError(
      "You are already a member of this workspace.",
      409,
    );

  await prisma.$transaction(async (tx) => {
    // Upsert membership (reactivate if was removed, or create new)
    await tx.workspaceMember.upsert({
      where: {
        workspaceId_userId: {
          workspaceId: invitation.workspaceId,
          userId,
        },
      },
      create: {
        workspaceId: invitation.workspaceId,
        userId,
        role: invitation.role,
        invitedBy: invitation.invitedBy,
        invitedAt: invitation.createdAt,
      },
      update: {
        isActive: true,
        role: invitation.role,
        invitedBy: invitation.invitedBy,
        invitedAt: invitation.createdAt,
      },
    });
    // Delete the invitation
    await tx.workspaceInvitation.delete({ where: { id: invitation.id } });
  });

  return { workspaceId: invitation.workspaceId };
}

export async function removeMember(
  userId: number,
  workspaceId: number,
  targetMemberId: number,
): Promise<void> {
  const requester = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId, isActive: true },
  });
  if (!requester) throw new AppError("Access denied.", 403);

  const target = await prisma.workspaceMember.findUnique({
    where: { id: targetMemberId },
  });
  if (!target || target.workspaceId !== workspaceId) {
    throw new AppError("Member not found.", 404);
  }

  // Owners cannot be removed
  if (target.role === "owner") {
    throw new AppError(
      "The workspace owner cannot be removed.",
      403,
    );
  }

  // Only owner or admin can remove; or self (leave)
  const isSelf = target.userId === userId;
  const isAdminOrOwner =
    requester.role === "owner" || requester.role === "admin";
  if (!isSelf && !isAdminOrOwner) {
    throw new AppError(
      "Only the owner or admin can remove members.",
      403,
    );
  }

  await prisma.workspaceMember.update({
    where: { id: targetMemberId },
    data: { isActive: false },
  });
}

export async function leaveWorkspace(
  userId: number,
  workspaceId: number,
): Promise<void> {
  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId, isActive: true },
  });
  if (!membership)
    throw new AppError(
      "You are not a member of this workspace.",
      404,
    );
  if (membership.role === "owner") {
    throw new AppError(
      "The workspace owner cannot leave. Transfer ownership or delete the workspace.",
      403,
    );
  }

  await prisma.workspaceMember.update({
    where: { id: membership.id },
    data: { isActive: false },
  });
}

export async function deleteWorkspace(
  userId: number,
  workspaceId: number,
  confirmationName: string,
): Promise<void> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  if (!workspace) throw new AppError("Workspace not found.", 404);

  const membership = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId, role: "owner" },
  });
  if (!membership)
    throw new AppError("Only the workspace owner can delete it.", 403);

  const membershipCount = await prisma.workspaceMember.count({ where: { userId } });
  if (membershipCount <= 1) {
    throw new AppError("Cannot delete your only workspace.", 400);
  }

  if (confirmationName !== workspace.name) {
    throw new AppError("Workspace name does not match.", 400);
  }

  const profile = await prisma.businessProfile.findUnique({ where: { workspaceId } });
  if (profile) {
    await prisma.businessProfile.delete({ where: { id: profile.id } });
  }

  await prisma.workspace.delete({ where: { id: workspaceId } });
}
