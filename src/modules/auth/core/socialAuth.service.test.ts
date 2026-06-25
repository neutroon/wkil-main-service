import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("@config/env", () => ({
  env: {
    GOOGLE_AUTH_CLIENT_ID: "google-client-id",
    FB_APP_ID: "fb-app-id",
    FB_APP_SECRET: "fb-secret",
    FB_AUTH_APP_ID: "fb-auth-app-id",
    FB_AUTH_APP_SECRET: "fb-auth-secret",
    FB_API_URL: "https://graph.facebook.com/v25.0",
  },
}));

vi.mock("@config/prisma", () => ({
  default: {
    socialIdentity: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import prisma from "@config/prisma";
import {
  authenticateSocialUser,
  verifyFacebookAccessToken,
  verifyGoogleIdToken,
} from "./socialAuth.service";

const mockedPrisma = prisma as any;

const baseUser = {
  id: 7,
  name: "Social User",
  email: "user@example.com",
  role: "user",
  isEmailVerified: true,
  lastVerificationSentAt: null,
  isBusinessProfileCreated: false,
  isSocialUser: false,
  avatar: null,
};

describe("social auth service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.socialIdentity.findUnique.mockResolvedValue(null);
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    mockedPrisma.$transaction.mockImplementation(async (callback: any) =>
      callback({
        user: mockedPrisma.user,
        socialIdentity: mockedPrisma.socialIdentity,
      }),
    );
  });

  it("creates a new verified user from Google", async () => {
    mockedPrisma.user.create.mockResolvedValue(baseUser);
    mockedPrisma.socialIdentity.create.mockResolvedValue({ id: 1 });

    const user = await authenticateSocialUser("google", {
      providerUserId: "google-123",
      email: "USER@Example.com",
      emailVerified: true,
      name: "Social User",
      avatarUrl: "https://example.com/avatar.png",
    });

    expect(user).toEqual(baseUser);
    expect(mockedPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: "user@example.com",
          role: "user",
          isEmailVerified: true,
        }),
      }),
    );
    expect(mockedPrisma.socialIdentity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "google",
          providerUserId: "google-123",
          userId: 7,
        }),
      }),
    );
  });

  it("creates a new verified user from Facebook", async () => {
    mockedPrisma.user.create.mockResolvedValue(baseUser);
    mockedPrisma.socialIdentity.create.mockResolvedValue({ id: 1 });

    const user = await authenticateSocialUser("facebook", {
      providerUserId: "facebook-123",
      email: "user@example.com",
      emailVerified: true,
      name: "Social User",
    });

    expect(user.id).toBe(7);
    expect(mockedPrisma.socialIdentity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "facebook",
          providerUserId: "facebook-123",
        }),
      }),
    );
  });

  it("signs in an existing user by linked identity", async () => {
    mockedPrisma.socialIdentity.findUnique.mockResolvedValue({
      id: 3,
      provider: "google",
      providerUserId: "google-123",
      email: "old@example.com",
      name: null,
      avatarUrl: null,
      user: { ...baseUser, isActive: true },
    });

    const user = await authenticateSocialUser("google", {
      providerUserId: "google-123",
      email: "user@example.com",
      emailVerified: true,
    });

    expect(user).toEqual(baseUser);
    expect(mockedPrisma.user.create).not.toHaveBeenCalled();
    expect(mockedPrisma.socialIdentity.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 3 },
        data: expect.objectContaining({ email: "user@example.com" }),
      }),
    );
  });

  it("links an identity to an existing active user by verified email", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      isActive: true,
      isEmailVerified: false,
    });
    mockedPrisma.socialIdentity.create.mockResolvedValue({ id: 4 });

    const user = await authenticateSocialUser("google", {
      providerUserId: "google-456",
      email: "user@example.com",
      emailVerified: true,
    });

    expect(user.isEmailVerified).toBe(true);
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 7 },
      data: expect.objectContaining({
        isEmailVerified: true,
        emailVerificationToken: null,
      }),
    });
    expect(mockedPrisma.socialIdentity.create).toHaveBeenCalled();
  });

  it("rejects inactive users", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      ...baseUser,
      isActive: false,
    });

    await expect(
      authenticateSocialUser("facebook", {
        providerUserId: "facebook-456",
        email: "user@example.com",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "ACCOUNT_INACTIVE" });
  });

  it("creates a no-email social user when Facebook returns no email", async () => {
    mockedPrisma.user.create.mockResolvedValue({
      ...baseUser,
      email: null,
      isEmailVerified: false,
      isSocialUser: true,
    });
    mockedPrisma.socialIdentity.create.mockResolvedValue({ id: 1 });

    const user = await authenticateSocialUser("facebook", {
      providerUserId: "facebook-noemail",
      email: "",
      emailVerified: false,
      name: "No Email User",
      avatarUrl: "https://example.com/avatar.png",
    });

    expect(user.email).toBeNull();
    expect(user.isEmailVerified).toBe(false);
    expect(user.isSocialUser).toBe(true);
    expect(mockedPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: null,
          isEmailVerified: false,
          isSocialUser: true,
          avatar: "https://example.com/avatar.png",
        }),
      }),
    );
    expect(mockedPrisma.socialIdentity.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "facebook",
          providerUserId: "facebook-noemail",
          email: null,
        }),
      }),
    );
  });

  it("treats unverified Google email as no email", async () => {
    mockedPrisma.user.create.mockResolvedValue({
      ...baseUser,
      email: null,
      isEmailVerified: false,
      isSocialUser: true,
    });
    mockedPrisma.socialIdentity.create.mockResolvedValue({ id: 1 });

    const user = await authenticateSocialUser("google", {
      providerUserId: "google-unverified",
      email: "user@example.com",
      emailVerified: false,
    });

    expect(user.email).toBeNull();
    expect(user.isEmailVerified).toBe(false);
  });

  it("backfills User.email when a no-email social login later returns an email", async () => {
    mockedPrisma.socialIdentity.findUnique.mockResolvedValue({
      id: 11,
      provider: "facebook",
      providerUserId: "facebook-later",
      email: null,
      name: null,
      avatarUrl: "https://example.com/avatar.png",
      user: { ...baseUser, isActive: true, email: null, isEmailVerified: false, isSocialUser: true, avatar: null },
    });
    mockedPrisma.user.findUnique.mockResolvedValueOnce(null); // email owner check

    const user = await authenticateSocialUser("facebook", {
      providerUserId: "facebook-later",
      email: "later@example.com",
      emailVerified: true,
    });

    expect(user.email).toBe("later@example.com");
    expect(user.isEmailVerified).toBe(true);
    expect(mockedPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({
          email: "later@example.com",
          isEmailVerified: true,
          emailVerificationToken: null,
        }),
      }),
    );
  });

  it("seeds User.avatar from the first social identity when missing", async () => {
    mockedPrisma.socialIdentity.findUnique.mockResolvedValue({
      id: 12,
      provider: "google",
      providerUserId: "google-avatar",
      email: "u@example.com",
      name: null,
      avatarUrl: "https://example.com/new-avatar.png",
      user: { ...baseUser, isActive: true, avatar: null },
    });

    await authenticateSocialUser("google", {
      providerUserId: "google-avatar",
      email: "u@example.com",
      emailVerified: true,
      avatarUrl: "https://example.com/new-avatar.png",
    });

    expect(mockedPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({
          avatar: "https://example.com/new-avatar.png",
        }),
      }),
    );
  });

  it("recovers from a P2002 race on (provider, providerUserId) and returns the existing user", async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed",
      { code: "P2002", clientVersion: "test" },
    );
    // First findIdentity returns null, then a concurrent insert happens, then the
    // catch handler calls findIdentity again and we return the now-existing user.
    mockedPrisma.socialIdentity.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 99,
        provider: "facebook",
        providerUserId: "facebook-race",
        email: "race@example.com",
        name: null,
        avatarUrl: null,
        user: { ...baseUser, isActive: true, email: "race@example.com" },
      });
    mockedPrisma.user.create.mockRejectedValue(p2002);

    const user = await authenticateSocialUser("facebook", {
      providerUserId: "facebook-race",
      email: "race@example.com",
      emailVerified: true,
    });

    expect(user.email).toBe("race@example.com");
  });

  it("rejects malformed Google tokens", async () => {
    await expect(verifyGoogleIdToken("not-a-jwt")).rejects.toMatchObject({
      code: "GOOGLE_TOKEN_INVALID",
    });
  });

  it("rejects invalid Facebook tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { app_id: "fb-auth-app-id", is_valid: false } }),
      }),
    );

    await expect(verifyFacebookAccessToken("bad-token")).rejects.toMatchObject({
      code: "FACEBOOK_TOKEN_INVALID",
    });

    vi.unstubAllGlobals();
  });
});
