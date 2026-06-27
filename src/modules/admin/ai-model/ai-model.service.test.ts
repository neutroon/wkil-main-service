import { describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => ({
  default: {
    aiModel: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
  },
}));

vi.mock("@config/env", () => ({
  env: {
    GEMINI_API_KEY: "test-key",
    AI_CHAT_FALLBACK_MODEL_TIERS:
      "gemini-3.1-flash-lite-preview,gemini-3-flash-preview,gemini-2.5-flash",
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

// The billing price-cache clear function. The real one walks its own
// module-level cache; here we just verify the wiring.
// vi.hoisted so vi.mock (which is hoisted above all imports) can reference it.
const { clearModelPriceCache } = vi.hoisted(() => ({
  clearModelPriceCache: vi.fn(),
}));
vi.mock("@modules/billing/billing.service", () => ({
  clearModelPriceCache,
}));

vi.mock("@config/cache-bus", () => ({
  publishCacheInvalidation: vi.fn(async () => undefined),
}));

import {
  clearAiModelCache,
  clearAiModelCacheLocal,
  getChatRuntimeConfig,
} from "./ai-model.service";
import prisma from "@config/prisma";

describe("clearAiModelCacheLocal (cross-cache wiring)", () => {
  it("clears both the chat config cache AND the billing price cache", async () => {
    // After a clear, getChatRuntimeConfig must hit the DB again.
    // Stub the DB to return a tier list so we can compare before/after.
    (prisma.aiModel.findMany as any).mockResolvedValue([
      { modelId: "gemini-3-flash", isDefault: true, maxOutputTokens: 1024, provider: "google" },
    ]);

    // First call: cache miss, populates the cache.
    await getChatRuntimeConfig();
    expect(prisma.aiModel.findMany).toHaveBeenCalledTimes(1);

    // Second call: cache hit, no DB read.
    await getChatRuntimeConfig();
    expect(prisma.aiModel.findMany).toHaveBeenCalledTimes(1);

    // Local clear must clear BOTH the chat runtime cache AND the price cache.
    clearAiModelCacheLocal();
    expect(clearModelPriceCache).toHaveBeenCalledTimes(1);

    // After clear, the next call must hit the DB again.
    await getChatRuntimeConfig();
    expect(prisma.aiModel.findMany).toHaveBeenCalledTimes(2);
  });

  it("does NOT publish on the cache bus (bus handler uses this variant)", async () => {
    const bus = await import("@config/cache-bus");
    vi.clearAllMocks();
    clearAiModelCacheLocal();
    await new Promise((r) => setImmediate(r));
    expect(bus.publishCacheInvalidation).not.toHaveBeenCalled();
  });
});

describe("clearAiModelCache (publishing variant)", () => {
  it("publishes 'ai_models' on the cache bus", async () => {
    const bus = await import("@config/cache-bus");
    vi.clearAllMocks();
    clearAiModelCache();
    await new Promise((r) => setImmediate(r));
    expect(bus.publishCacheInvalidation).toHaveBeenCalledWith("ai_models");
  });
});
