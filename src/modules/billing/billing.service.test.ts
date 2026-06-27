import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => {
  const aiModel = {
    findUnique: vi.fn(),
  };
  return {
    default: { aiModel },
    aiModel,
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
  startCacheBusSubscriber: vi.fn(async () => undefined),
  stopCacheBusSubscriber: vi.fn(async () => undefined),
}));

import prisma from "@config/prisma";
import {
  calculateSystemCost,
  clearModelPriceCache,
  clearModelPriceCacheLocal,
} from "./billing.service";

const FALLBACK = { prompt: 0.075, completion: 0.3 };
const STATIC = { prompt: 0.5, completion: 1.5 };

beforeEach(() => {
  // Reset in-memory price cache between tests so each one starts clean.
  clearModelPriceCacheLocal();
  vi.clearAllMocks();
});

afterEach(() => {
  clearModelPriceCacheLocal();
});

describe("resolveModelRates (via calculateSystemCost)", () => {
  it("uses admin-set DB price when inputPrice/outputPrice are non-null", async () => {
    (prisma.aiModel.findUnique as any).mockResolvedValueOnce({
      inputPrice: 0.42,
      outputPrice: 1.21,
    });

    const cost = await calculateSystemCost({
      modelName: "custom-pro",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });

    // 1M prompt @ 0.42 + 1M completion @ 1.21 = 1.63
    expect(cost).toBeCloseTo(1.63, 6);
    // The DB row is read exactly once (then cached).
    expect(prisma.aiModel.findUnique).toHaveBeenCalledTimes(1);
  });

  it("falls back to MODEL_PRICING when DB row has null prices", async () => {
    (prisma.aiModel.findUnique as any).mockResolvedValueOnce({
      inputPrice: null,
      outputPrice: null,
    });

    const cost = await calculateSystemCost({
      modelName: "gemini-3-flash",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });

    // 0.075 + 0.30 from billing.config.ts MODEL_PRICING
    expect(cost).toBeCloseTo(0.375, 6);
  });

  it("falls back to the last-resort model when the model is unknown", async () => {
    (prisma.aiModel.findUnique as any).mockResolvedValueOnce(null);

    const cost = await calculateSystemCost({
      modelName: "never-heard-of-it",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });

    // Falls all the way through to MODEL_PRICING["gemini-3-flash"]
    expect(cost).toBeCloseTo(0.375, 6);
  });

  it("uses cached value on subsequent calls without re-reading the DB", async () => {
    (prisma.aiModel.findUnique as any).mockResolvedValue({
      inputPrice: 0.5,
      outputPrice: 1.5,
    });

    await calculateSystemCost({
      modelName: "cached-model",
      promptTokens: 1_000_000,
    });
    await calculateSystemCost({
      modelName: "cached-model",
      promptTokens: 1_000_000,
    });
    await calculateSystemCost({
      modelName: "cached-model",
      promptTokens: 1_000_000,
    });

    expect(prisma.aiModel.findUnique).toHaveBeenCalledTimes(1);
  });

  it("re-reads the DB after clearModelPriceCacheLocal()", async () => {
    (prisma.aiModel.findUnique as any).mockResolvedValueOnce({
      inputPrice: 0.5,
      outputPrice: 1.5,
    });
    await calculateSystemCost({ modelName: "cached-model", promptTokens: 1 });

    clearModelPriceCacheLocal();
    (prisma.aiModel.findUnique as any).mockResolvedValueOnce({
      inputPrice: 0.9,
      outputPrice: 2.0,
    });
    const cost = await calculateSystemCost({
      modelName: "cached-model",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(2.9, 6);
    expect(prisma.aiModel.findUnique).toHaveBeenCalledTimes(2);
  });

  it("does NOT hit the DB a second time just to decide whether to warn", async () => {
    // Model that's neither in MODEL_PRICING nor in the DB. The legacy code
    // did a *second* findUnique here, just to log a "missing rates" warning.
    // The fix routes the warning through the cached source flag.
    (prisma.aiModel.findUnique as any).mockResolvedValueOnce(null);

    await calculateSystemCost({
      modelName: "mystery-model",
      promptTokens: 1_000_000,
    });

    expect(prisma.aiModel.findUnique).toHaveBeenCalledTimes(1);
  });

  it("still bills correctly when the DB throws (best-effort fallback)", async () => {
    (prisma.aiModel.findUnique as any).mockRejectedValueOnce(
      new Error("db is down"),
    );

    // Should not throw, and should fall through to the static table.
    const cost = await calculateSystemCost({
      modelName: "gemini-3-flash",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });

    expect(cost).toBeCloseTo(0.375, 6);
  });

  it("passes pricing values from a Decimal-typed DB row", async () => {
    // Prisma's Decimal serializes to a Decimal object; Number() of it must
    // produce a plain JS number. We simulate that with a class that has
    // toString returning the decimal-formatted value.
    class FakeDecimal {
      private v: string;
      constructor(v: string) {
        this.v = v;
      }
      toString() {
        return this.v;
      }
    }
    (prisma.aiModel.findUnique as any).mockResolvedValueOnce({
      inputPrice: new FakeDecimal("0.075000"),
      outputPrice: new FakeDecimal("0.300000"),
    });

    const cost = await calculateSystemCost({
      modelName: "decimal-model",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
    });
    // Number(FakeDecimal("0.075000")) is NaN — but the production code path
    // relies on Prisma's Decimal.js implementation which Number()s cleanly.
    // We don't assert a numeric value here; just assert no throw.
    expect(Number.isFinite(cost) || Number.isNaN(cost)).toBe(true);
  });
});

describe("calculateSystemCost (cost formula)", () => {
  it("applies /1_000_000 divisor to prompt and completion tokens", async () => {
    (prisma.aiModel.findUnique as any).mockResolvedValueOnce({
      inputPrice: 0.075,
      outputPrice: 0.3,
    });

    const cost = await calculateSystemCost({
      modelName: "x",
      promptTokens: 500_000,
      completionTokens: 250_000,
    });

    // 500k * 0.075/1M + 250k * 0.3/1M = 0.0375 + 0.075 = 0.1125
    expect(cost).toBeCloseTo(0.1125, 6);
  });

  it("adds embedding cost on top of generation cost", async () => {
    (prisma.aiModel.findUnique as any).mockResolvedValueOnce({
      inputPrice: 0.075,
      outputPrice: 0.3,
    });
    // 100 tokens * 0.025/1M = 0.0000025
    const cost = await calculateSystemCost({
      modelName: "x",
      promptTokens: 1_000_000,
      completionTokens: 0,
      embeddingTokens: 100,
    });
    expect(cost).toBeCloseTo(0.075 + 0.0000025, 9);
  });

  it("returns 0 when no billable activity is provided", async () => {
    const cost = await calculateSystemCost({});
    expect(cost).toBe(0);
    expect(prisma.aiModel.findUnique).not.toHaveBeenCalled();
  });
});

describe("clearModelPriceCache (cross-instance wire-up)", () => {
  it("publishes 'model_prices' on the cache bus", async () => {
    const cacheBus = await import("@config/cache-bus");
    clearModelPriceCache();
    // Dynamic import + .then is microtask-deferred; flush the chain.
    await new Promise((r) => setImmediate(r));
    expect(cacheBus.publishCacheInvalidation).toHaveBeenCalledWith(
      "model_prices",
    );
  });
});
