import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => ({
  default: {
    user: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    socialIdentity: {
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@modules/mail/mail.service", () => ({
  sendVerificationEmail: vi.fn(),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import prisma from "@config/prisma";
import { sendVerificationEmail } from "@modules/mail/mail.service";
import {
  addEmailToCurrentUser,
  resendEmailVerificationForCurrentUser,
} from "./user.service";

const mockedPrisma = prisma as any;

describe("user service add-email flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendVerificationEmail).mockResolvedValue(undefined);
    // First findFirst call returns the current user; subsequent findFirst calls
    // (collision check, getUserById) return null.
    mockedPrisma.user.findFirst
      .mockResolvedValueOnce({
        id: 7,
        email: null,
        isSocialUser: true,
        name: "No Email User",
      })
      .mockResolvedValue(null);
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    mockedPrisma.user.update.mockResolvedValue({});
    mockedPrisma.socialIdentity.updateMany.mockResolvedValue({ count: 1 });
  });

  it("attaches a new email and sends a verification email", async () => {
    const result = await addEmailToCurrentUser(7, "  New@Example.com  ");

    expect(result).toBeDefined();
    expect(mockedPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ email: "new@example.com" }),
        select: { id: true },
      }),
    );
    expect(mockedPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({
          email: "new@example.com",
          isEmailVerified: false,
          emailVerificationToken: expect.any(String),
          lastVerificationSentAt: expect.any(Date),
        }),
      }),
    );
    expect(mockedPrisma.socialIdentity.updateMany).toHaveBeenCalledWith({
      where: { userId: 7 },
      data: { email: "new@example.com" },
    });
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      "new@example.com",
      "No Email User",
      expect.any(String),
    );
  });

  it("rejects when the user already has an email", async () => {
    mockedPrisma.user.findFirst.mockReset().mockResolvedValue({
      id: 7,
      email: "existing@example.com",
      isSocialUser: true,
      name: "Has Email",
    });

    await expect(
      addEmailToCurrentUser(7, "another@example.com"),
    ).rejects.toMatchObject({ code: "EMAIL_ALREADY_SET" });

    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("rejects when the email is already taken by another user", async () => {
    // First findFirst returns the current user, second returns a collision.
    mockedPrisma.user.findFirst
      .mockReset()
      .mockResolvedValueOnce({
        id: 7,
        email: null,
        isSocialUser: true,
        name: "No Email User",
      })
      .mockResolvedValueOnce({ id: 99 });

    await expect(
      addEmailToCurrentUser(7, "taken@example.com"),
    ).rejects.toMatchObject({ code: "EMAIL_ALREADY_TAKEN" });

    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("rejects when the user does not exist", async () => {
    mockedPrisma.user.findFirst.mockReset().mockResolvedValue(null);

    await expect(
      addEmailToCurrentUser(7, "x@example.com"),
    ).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
  });
});

describe("user service resend-email-verification flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendVerificationEmail).mockResolvedValue(undefined);
    mockedPrisma.user.update.mockResolvedValue({});
  });

  it("sends a fresh verification email when below the cooldown", async () => {
    mockedPrisma.user.findFirst.mockResolvedValue({
      id: 7,
      email: "u@example.com",
      isEmailVerified: false,
      lastVerificationSentAt: null,
      name: "U",
    });

    const result = await resendEmailVerificationForCurrentUser(7);

    expect(result.message).toBe("Verification email sent.");
    expect(mockedPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 7 },
        data: expect.objectContaining({
          emailVerificationToken: expect.any(String),
          lastVerificationSentAt: expect.any(Date),
        }),
      }),
    );
    expect(sendVerificationEmail).toHaveBeenCalledWith(
      "u@example.com",
      "U",
      expect.any(String),
    );
  });

  it("returns immediately when the email is already verified", async () => {
    mockedPrisma.user.findFirst.mockResolvedValue({
      id: 7,
      email: "u@example.com",
      isEmailVerified: true,
      lastVerificationSentAt: null,
      name: "U",
    });

    const result = await resendEmailVerificationForCurrentUser(7);

    expect(result.message).toBe("Email is already verified.");
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("rejects when within the cooldown window", async () => {
    const fifteenSecondsAgo = new Date(Date.now() - 15 * 1000);
    mockedPrisma.user.findFirst.mockResolvedValue({
      id: 7,
      email: "u@example.com",
      isEmailVerified: false,
      lastVerificationSentAt: fifteenSecondsAgo,
      name: "U",
    });

    await expect(
      resendEmailVerificationForCurrentUser(7),
    ).rejects.toMatchObject({ code: undefined }); // AppError with 429 status, no code
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it("rejects when the user has no email on file", async () => {
    mockedPrisma.user.findFirst.mockResolvedValue({
      id: 7,
      email: null,
      isEmailVerified: false,
      lastVerificationSentAt: null,
      name: "U",
    });

    await expect(
      resendEmailVerificationForCurrentUser(7),
    ).rejects.toMatchObject({ code: "EMAIL_NOT_SET" });
  });
});
