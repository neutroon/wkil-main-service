import { describe, expect, it, vi } from "vitest";

const prisma = vi.hoisted(() => ({
  workspace: { create: vi.fn(), findUnique: vi.fn() },
  workspaceMember: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
  businessProfile: { findFirst: vi.fn() },
  user: { findUnique: vi.fn(), create: vi.fn() },
  $transaction: vi.fn(),
}));

vi.mock("@config/prisma", () => ({ default: prisma }));

vi.mock("@modules/auth/core/tokenCrypto", () => ({
  generateRandomToken: () => "tok",
  hashToken: (t: string) => `h_${t}`,
}));

vi.mock("@modules/mail/mail.service", () => ({
  sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("bcrypt", () => ({ default: { hash: vi.fn().mockResolvedValue("h") } }));

vi.mock("@modules/settings/settings.service", () => ({
  getBillingMultiplier: vi.fn(),
}));

vi.mock("@modules/billing/billing.service", () => ({
  clearQuotaCache: vi.fn(),
}));

vi.mock("@modules/auth/core/auth.service", () => ({
  verifyCredentials: vi.fn(),
}));

import {
  getActiveProfileId,
  provisionWorkspaceForUser,
} from "./workspace.service";
import { AppError } from "@middlewares/errorHandler.middleware";

describe("provisionWorkspaceForUser", () => {
  it("creates workspace, skeleton profile, and owner membership in one tx", async () => {
    const tx: any = {
      workspace: { create: vi.fn().mockResolvedValue({ id: 11 }) },
      businessProfile: { create: vi.fn().mockResolvedValue({ id: 7 }) },
      workspaceMember: { create: vi.fn() },
    };
    const out = await provisionWorkspaceForUser(tx, 3, "Hesham");
    expect(tx.workspace.create).toHaveBeenCalledWith({
      data: { name: "My Workspace" },
    });
    expect(tx.businessProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 3,
        workspaceId: 11,
        name: "My Business",
        setupCompletedAt: null,
      }),
    });
    expect(tx.workspaceMember.create).toHaveBeenCalledWith({
      data: { workspaceId: 11, userId: 3, role: "owner" },
    });
    expect(out).toEqual({ workspaceId: 11, profileId: 7 });
  });
});

describe("signup wiring", () => {
  it("password signup provisions the tenant trio", async () => {
    const { createUser } = await import("@modules/auth/user/user.service");
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 42,
      email: "a@b.c",
      name: "Hesham",
    });
    // createUser must run provisioning inside a transaction — assert
    // prisma.$transaction is used and that the tenant trio lands in it.
    const tx = {
      user: { create: prisma.user.create },
      workspace: { create: vi.fn().mockResolvedValue({ id: 1 }) },
      businessProfile: { create: vi.fn().mockResolvedValue({ id: 2 }) },
      workspaceMember: { create: vi.fn() },
    };
    prisma.$transaction.mockImplementation(async (fn: any) => fn(tx));

    await createUser("Hesham", "a@b.c", "pw");

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(tx.workspace.create).toHaveBeenCalledWith({
      data: { name: "My Workspace" },
    });
    expect(tx.businessProfile.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 42,
        workspaceId: 1,
        name: "My Business",
        setupCompletedAt: null,
      }),
    });
    expect(tx.workspaceMember.create).toHaveBeenCalledWith({
      data: { workspaceId: 1, userId: 42, role: "owner" },
    });
  });
});

describe("getActiveProfileId", () => {
  it("uses the explicit businessProfileId when accessible", async () => {
    prisma.workspaceMember.findMany.mockResolvedValue([
      { workspace: { profile: { id: 5 } } },
      { workspace: { profile: { id: 9 } } },
    ]);
    await expect(getActiveProfileId(3, 9)).resolves.toBe(9);
  });

  it("rejects an inaccessible explicit id", async () => {
    prisma.workspaceMember.findMany.mockResolvedValue([
      { workspace: { profile: { id: 5 } } },
    ]);
    await expect(getActiveProfileId(3, 9)).rejects.toThrow(AppError);
  });

  it("falls back to the single membership profile", async () => {
    prisma.workspaceMember.findMany.mockResolvedValue([
      { workspace: { profile: { id: 5 } } },
    ]);
    await expect(getActiveProfileId(3)).resolves.toBe(5);
  });

  it("throws 400 when several profiles are accessible and none explicit", async () => {
    prisma.workspaceMember.findMany.mockResolvedValue([
      { workspace: { profile: { id: 5 } } },
      { workspace: { profile: { id: 9 } } },
    ]);
    await expect(getActiveProfileId(3)).rejects.toThrow(
      "Multiple business profiles found",
    );
  });

  it("throws 404 when the user has no active memberships", async () => {
    prisma.workspaceMember.findMany.mockResolvedValue([]);
    await expect(getActiveProfileId(3)).rejects.toThrow("Business profile not found.");
  });

  it("honors an explicit activeWorkspaceId over 'earliest created'", async () => {
    prisma.workspaceMember.findMany.mockResolvedValue([
      { workspaceId: 2, workspace: { profile: { id: 9 } } },
      { workspaceId: 1, workspace: { profile: { id: 5 } } },
    ]);
    await expect(getActiveProfileId(3, undefined, 2)).resolves.toBe(9);
  });
});
