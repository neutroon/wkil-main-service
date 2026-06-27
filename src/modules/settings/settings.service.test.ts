import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => {
  const systemSetting = {
    findUnique: vi.fn(),
    upsert: vi.fn(),
  };
  return {
    default: { systemSetting },
    systemSetting,
  };
});

vi.mock("@utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@config/cache-bus", () => ({
  publishCacheInvalidation: vi.fn(async () => undefined),
}));

import prisma from "@config/prisma";
import {
  clearSettingsCache,
  clearSettingsCacheLocal,
  getBillingMultiplier,
  getSystemSetting,
  updateSystemSetting,
} from "./settings.service";

beforeEach(() => {
  clearSettingsCacheLocal();
  vi.clearAllMocks();
});

afterEach(() => {
  clearSettingsCacheLocal();
});

describe("getSystemSetting", () => {
  it("returns the value from the DB on cache miss", async () => {
    (prisma.systemSetting.findUnique as any).mockResolvedValueOnce({
      key: "billing_multiplier",
      value: "3.0",
    });
    expect(await getSystemSetting("billing_multiplier", "2.5")).toBe("3.0");
  });

  it("returns the default when the row is missing", async () => {
    (prisma.systemSetting.findUnique as any).mockResolvedValueOnce(null);
    expect(await getSystemSetting("missing", "fallback")).toBe("fallback");
  });

  it("caches the value across calls (no second DB hit)", async () => {
    (prisma.systemSetting.findUnique as any).mockResolvedValueOnce({
      key: "k",
      value: "v",
    });
    await getSystemSetting("k", "d");
    await getSystemSetting("k", "d");
    await getSystemSetting("k", "d");
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(1);
  });

  it("returns the default and does not throw when the DB errors", async () => {
    (prisma.systemSetting.findUnique as any).mockRejectedValueOnce(
      new Error("db down"),
    );
    expect(await getSystemSetting("k", "safe")).toBe("safe");
  });
});

describe("getBillingMultiplier", () => {
  it("parses the cached string value as a number", async () => {
    (prisma.systemSetting.findUnique as any).mockResolvedValueOnce({
      key: "billing_multiplier",
      value: "4.2",
    });
    expect(await getBillingMultiplier()).toBe(4.2);
  });
});

describe("updateSystemSetting", () => {
  it("upserts the row in the DB", async () => {
    (prisma.systemSetting.upsert as any).mockResolvedValueOnce({
      key: "billing_multiplier",
      value: "5.0",
    });
    await updateSystemSetting("billing_multiplier", "5.0");
    expect(prisma.systemSetting.upsert).toHaveBeenCalledTimes(1);
  });

  it("clears the local cache after a successful write", async () => {
    (prisma.systemSetting.findUnique as any).mockResolvedValueOnce({
      key: "k",
      value: "old",
    });
    await getSystemSetting("k", "d"); // populate cache
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(1);

    (prisma.systemSetting.upsert as any).mockResolvedValueOnce({
      key: "k",
      value: "new",
    });
    await updateSystemSetting("k", "new");

    (prisma.systemSetting.findUnique as any).mockResolvedValueOnce({
      key: "k",
      value: "new",
    });
    const value = await getSystemSetting("k", "d");
    // After clear, we had to hit the DB again to get the new value.
    expect(prisma.systemSetting.findUnique).toHaveBeenCalledTimes(2);
    expect(value).toBe("new");
  });

  it("publishes 'settings' on the cache bus so peers also clear", async () => {
    const cacheBus = await import("@config/cache-bus");
    (prisma.systemSetting.upsert as any).mockResolvedValueOnce({
      key: "k",
      value: "v",
    });
    updateSystemSetting("k", "v");
    await new Promise((r) => setImmediate(r));
    expect(cacheBus.publishCacheInvalidation).toHaveBeenCalledWith("settings");
  });

  it("rethrows on DB error so the caller can surface the failure", async () => {
    (prisma.systemSetting.upsert as any).mockRejectedValueOnce(
      new Error("db down"),
    );
    await expect(updateSystemSetting("k", "v")).rejects.toThrow("db down");
  });
});

describe("clearSettingsCache (publishing variant)", () => {
  it("publishes 'settings' on the cache bus", async () => {
    const cacheBus = await import("@config/cache-bus");
    clearSettingsCache();
    await new Promise((r) => setImmediate(r));
    expect(cacheBus.publishCacheInvalidation).toHaveBeenCalledWith("settings");
  });
});

describe("clearSettingsCacheLocal (no-publish variant)", () => {
  it("does NOT publish — used by the cache-bus subscriber to avoid loops", async () => {
    const cacheBus = await import("@config/cache-bus");
    clearSettingsCacheLocal();
    await new Promise((r) => setImmediate(r));
    expect(cacheBus.publishCacheInvalidation).not.toHaveBeenCalled();
  });
});
