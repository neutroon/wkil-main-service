import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => ({
  default: {
    deviceToken: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    businessProfile: {
      findMany: vi.fn(),
    },
  },
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
import {
  deleteDeviceToken,
  deleteDeviceTokens,
  listActiveTokensForBusiness,
  listActiveTokensForUser,
  touchDeviceToken,
  upsertDeviceToken,
} from "./deviceToken.service";

const mockedPrisma = prisma as unknown as {
  deviceToken: {
    upsert: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  businessProfile: {
    findMany: ReturnType<typeof vi.fn>;
  };
};

describe("deviceToken.service.upsertDeviceToken", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts by unique token and refreshes lastSeenAt", async () => {
    mockedPrisma.deviceToken.upsert.mockResolvedValueOnce({});

    await upsertDeviceToken({
      userId: 42,
      token: "fcm-token-aaa",
      platform: "ios",
    });

    expect(mockedPrisma.deviceToken.upsert).toHaveBeenCalledOnce();
    const call = mockedPrisma.deviceToken.upsert.mock.calls[0]![0] as {
      where: { token: string };
      create: { userId: number; token: string; platform: string };
      update: { userId: number; platform: string; lastSeenAt: Date };
    };
    expect(call.where).toEqual({ token: "fcm-token-aaa" });
    expect(call.create).toEqual({
      userId: 42,
      token: "fcm-token-aaa",
      platform: "ios",
    });
    expect(call.update.userId).toBe(42);
    expect(call.update.platform).toBe("ios");
    expect(call.update.lastSeenAt).toBeInstanceOf(Date);
  });

  it("propagates DB errors (caller decides what to do)", async () => {
    mockedPrisma.deviceToken.upsert.mockRejectedValueOnce(
      new Error("db connection lost"),
    );
    await expect(
      upsertDeviceToken({ userId: 1, token: "t", platform: "android" }),
    ).rejects.toThrow("db connection lost");
  });
});

describe("deviceToken.service.deleteDeviceToken", () => {
  beforeEach(() => vi.clearAllMocks());

  it("filters by userId AND token so a caller can't delete someone else's row", async () => {
    mockedPrisma.deviceToken.deleteMany.mockResolvedValueOnce({ count: 1 });
    await deleteDeviceToken({ userId: 7, token: "t" });
    expect(mockedPrisma.deviceToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 7, token: "t" },
    });
  });
});

describe("deviceToken.service.deleteDeviceTokens (bulk)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 0 and skips the query when input is empty", async () => {
    const removed = await deleteDeviceTokens([]);
    expect(removed).toBe(0);
    expect(mockedPrisma.deviceToken.deleteMany).not.toHaveBeenCalled();
  });

  it("issues a single IN query and returns the row count", async () => {
    mockedPrisma.deviceToken.deleteMany.mockResolvedValueOnce({ count: 3 });
    const removed = await deleteDeviceTokens(["a", "b", "c"]);
    expect(removed).toBe(3);
    expect(mockedPrisma.deviceToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ["a", "b", "c"] } },
    });
  });
});

describe("deviceToken.service.listActiveTokensForUser", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applies the 90-day freshness window and the optional platform filter", async () => {
    mockedPrisma.deviceToken.findMany.mockResolvedValueOnce([
      { token: "a" },
      { token: "b" },
    ]);

    const before = Date.now();
    const result = await listActiveTokensForUser({ userId: 9, platform: "ios" });
    const after = Date.now();

    expect(result).toEqual(["a", "b"]);
    const call = mockedPrisma.deviceToken.findMany.mock.calls[0]![0] as {
      where: {
        userId: number;
        lastSeenAt: { gte: Date };
        platform?: string;
      };
    };
    expect(call.where.userId).toBe(9);
    expect(call.where.platform).toBe("ios");
    const cutoffMs = (call.where.lastSeenAt.gte as Date).getTime();
    // 90 days in ms, with a 1s tolerance for clock skew between the
    // two `Date.now()` captures.
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 90 * 86400 * 1000 - 1000);
    expect(cutoffMs).toBeLessThanOrEqual(after - 90 * 86400 * 1000 + 1000);
  });
});

describe("deviceToken.service.listActiveTokensForBusiness", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns [] when no business profile matches", async () => {
    mockedPrisma.businessProfile.findMany.mockResolvedValueOnce([]);
    const result = await listActiveTokensForBusiness({
      businessProfileId: 999,
    });
    expect(result).toEqual([]);
    expect(mockedPrisma.deviceToken.findMany).not.toHaveBeenCalled();
  });

  it("fans out across all users owning the business", async () => {
    mockedPrisma.businessProfile.findMany.mockResolvedValueOnce([
      { userId: 1 },
      { userId: 2 },
    ]);
    mockedPrisma.deviceToken.findMany.mockResolvedValueOnce([
      { token: "x" },
      { token: "y" },
      { token: "z" },
    ]);

    const result = await listActiveTokensForBusiness({
      businessProfileId: 5,
    });

    expect(result).toEqual(["x", "y", "z"]);
    expect(mockedPrisma.businessProfile.findMany).toHaveBeenCalledWith({
      where: { id: 5 },
      select: { userId: true },
    });
    const deviceCall = mockedPrisma.deviceToken.findMany.mock.calls[0]![0] as {
      where: { userId: { in: number[] }; lastSeenAt: { gte: Date } };
    };
    expect(deviceCall.where.userId.in).toEqual([1, 2]);
  });
});

describe("deviceToken.service.touchDeviceToken", () => {
  beforeEach(() => vi.clearAllMocks());

  it("swallows errors so a failed keep-alive never breaks the caller", async () => {
    mockedPrisma.deviceToken.updateMany.mockRejectedValueOnce(
      new Error("transient"),
    );
    // Must resolve, not reject.
    await expect(touchDeviceToken("t")).resolves.toBeUndefined();
  });
});
