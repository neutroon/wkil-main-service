import { beforeEach, describe, expect, it, vi } from "vitest";

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
      data: {
        isEmailVerified: true,
        emailVerificationToken: null,
      },
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

  it("rejects missing or unverified provider email", async () => {
    await expect(
      authenticateSocialUser("google", {
        providerUserId: "google-789",
        email: "",
        emailVerified: true,
      }),
    ).rejects.toMatchObject({ code: "SOCIAL_EMAIL_MISSING" });

    await expect(
      authenticateSocialUser("google", {
        providerUserId: "google-789",
        email: "user@example.com",
        emailVerified: false,
      }),
    ).rejects.toMatchObject({ code: "SOCIAL_EMAIL_UNVERIFIED" });
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
