import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@modules/auth/core/auth.service", () => ({
  AppError: class AppError extends Error {
    statusCode = 404;
    constructor(message: string) {
      super(message);
    }
  },
  verifyCredentials: vi.fn(),
  issueAuthSession: vi.fn(),
  publicUserShape: vi.fn((user: Record<string, unknown>) => ({
    id: user.id,
    name: user.name,
    email: user.email,
  })),
  getMobileUserShape: vi.fn((user: Record<string, unknown>) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    plan: user.plan,
    monthlyCreditsUsed: user.monthlyCreditsUsed,
    monthlyCreditLimit: user.monthlyCreditLimit,
    createdAt: user.createdAt,
  })),
}));

vi.mock("@modules/auth/user/user.service", () => ({
  getUserById: vi.fn(),
}));

import {
  getMobileUserShape,
  issueAuthSession,
  verifyCredentials,
} from "@modules/auth/core/auth.service";
import { getUserById } from "@modules/auth/user/user.service";
import { mobileCurrentUser, mobileLogin } from "./mobileAuth.controller";

const response = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn(),
}) as any;

describe("mobile auth profile projection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("includes authoritative profile values in login and refresh responses", async () => {
    vi.mocked(verifyCredentials).mockResolvedValue({
      id: 7,
      name: "Owner",
      email: "owner@example.com",
      role: "owner",
      avatar: null,
      isEmailVerified: true,
      isSocialUser: false,
      isBusinessProfileCreated: true,
      lastVerificationSentAt: null,
      plan: "PRO",
      monthlyCreditsUsed: 14280,
      monthlyCreditQuota: null,
      createdAt: new Date("2026-01-12T00:00:00.000Z"),
    } as any);
    vi.mocked(issueAuthSession).mockResolvedValue({
      accessToken: "a",
      refreshToken: "r",
      expiresIn: 900,
    });
    vi.mocked(getUserById).mockResolvedValue({
      id: 7,
      name: "Owner",
      email: "owner@example.com",
      plan: "PRO",
      monthlyCreditsUsed: 14280,
      monthlyCreditLimit: 50000,
      createdAt: new Date("2026-01-12T00:00:00.000Z"),
    } as any);

    const loginResponse = response();
    await mobileLogin(
      { body: { email: "owner@example.com", password: "secret" } } as any,
      loginResponse,
    );
    expect(loginResponse.json).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({
          plan: "PRO",
          monthlyCreditsUsed: 14280,
        }),
      }),
    );

    const refreshResponse = response();
    await mobileCurrentUser({ user: { id: 7 } } as any, refreshResponse);
    expect(refreshResponse.json).toHaveBeenCalledWith({
      user: expect.objectContaining({ monthlyCreditLimit: 50000 }),
    });
    expect(getMobileUserShape).toHaveBeenCalled();
  });

  it("throws when the authenticated account no longer exists", async () => {
    vi.mocked(getUserById).mockResolvedValue(null);
    await expect(
      mobileCurrentUser({ user: { id: 7 } } as any, response()),
    ).rejects.toThrow("User not found");
  });
});
