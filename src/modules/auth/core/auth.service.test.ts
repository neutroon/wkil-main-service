import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("@modules/mail/mail.service", () => ({
  sendVerificationEmail: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
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
import { sendPasswordResetEmail } from "@modules/mail/mail.service";
import { forgotPassword } from "./auth.service";

const mockedPrisma = prisma as any;
const resetResponse = {
  message: "If an account exists with that email, a reset link has been sent.",
};

describe("auth service password recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedPrisma.user.findUnique.mockResolvedValue(null);
    mockedPrisma.user.update.mockResolvedValue({});
    vi.mocked(sendPasswordResetEmail).mockResolvedValue(undefined);
  });

  it("keeps the forgot-password response generic when no active user exists", async () => {
    const result = await forgotPassword(" Missing@Example.com ");

    expect(result).toEqual(resetResponse);
    expect(mockedPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "missing@example.com", isActive: true },
    });
    expect(mockedPrisma.user.update).not.toHaveBeenCalled();
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it("keeps the forgot-password response generic if SMTP delivery fails", async () => {
    mockedPrisma.user.findUnique.mockResolvedValue({
      id: 12,
      email: "owner@example.com",
      name: "Owner",
    });
    vi.mocked(sendPasswordResetEmail).mockRejectedValue(new Error("SMTP rejected"));

    const result = await forgotPassword("OWNER@EXAMPLE.COM");

    expect(result).toEqual(resetResponse);
    expect(mockedPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: {
        passwordResetToken: expect.any(String),
        passwordResetExpires: expect.any(Date),
      },
    });
    expect(sendPasswordResetEmail).toHaveBeenCalledWith(
      "owner@example.com",
      "Owner",
      expect.any(String),
    );
  });
});
