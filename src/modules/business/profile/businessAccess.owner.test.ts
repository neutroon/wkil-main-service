import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => ({
  default: { businessProfile: { findFirst: vi.fn() } },
}));
vi.mock("@utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";
import { updateBusinessProfileForOwner } from "./businessAccess.service";

const mockedPrisma = prisma as unknown as {
  businessProfile: { findFirst: ReturnType<typeof vi.fn> };
};

describe("updateBusinessProfileForOwner", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws 404 when the profile is not owned", async () => {
    mockedPrisma.businessProfile.findFirst.mockResolvedValueOnce(null);
    await expect(
      updateBusinessProfileForOwner(5, 9, { name: "X" }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
