import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  creditsUsed: 0,
  events: new Map<string, Record<string, unknown>>(),
  aggregateWrites: 0,
  transactionCalls: 0,
}));

vi.mock("@config/prisma", () => ({
  default: {
    aiModel: { findUnique: vi.fn().mockResolvedValue({ inputPrice: 1000, outputPrice: 1000 }) },
    aiCallLog: {
      findUnique: vi.fn(async ({ where }: any) => state.events.get(where.eventId) ?? null),
      create: vi.fn((args: any) => ({ kind: "log", args })),
    },
    aiUsageStat: {
      upsert: vi.fn((args: any) => ({ kind: "aggregate", args })),
    },
    user: {
      findUnique: vi.fn(async () => ({ plan: "FREE", monthlyCreditQuota: 1, monthlyCreditsUsed: state.creditsUsed })),
      update: vi.fn((args: any) => ({ kind: "user", args })),
    },
    $transaction: vi.fn(async (operations: any[]) => {
      state.transactionCalls += 1;
      const log = operations.find((operation) => operation.kind === "log")?.args.data;
      if (log?.eventId && state.events.has(log.eventId)) {
        throw Object.assign(new Error("duplicate"), { code: "P2002" });
      }
      if (log?.eventId) state.events.set(log.eventId, log);
      state.aggregateWrites += operations.filter((operation) => operation.kind === "aggregate").length;
      state.creditsUsed += operations.find((operation) => operation.kind === "user")?.args.data.monthlyCreditsUsed.increment ?? 0;
    }),
  },
}));
vi.mock("@modules/settings/settings.service", () => ({ getBillingMultiplier: vi.fn().mockResolvedValue(1) }));
vi.mock("@modules/realtime/socketSync.service", () => ({ syncCreditsUpdate: vi.fn() }));
vi.mock("@utils/logger", () => ({ logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { assertQuotaAvailable, clearModelPriceCacheLocal, clearQuotaCache, recordAiUsage } from "./billing.service";
import { syncCreditsUpdate } from "@modules/realtime/socketSync.service";

const usage = {
  eventId: "model-run-1",
  userId: 321,
  businessProfileId: null,
  modelName: "test-model",
  operation: "copilot",
  conversationId: "thread-1",
  promptTokens: 1,
  completionTokens: 0,
};

beforeEach(() => {
  state.creditsUsed = 0;
  state.events.clear();
  state.aggregateWrites = 0;
  state.transactionCalls = 0;
  clearModelPriceCacheLocal();
  clearQuotaCache(usage.userId);
});
afterEach(() => clearQuotaCache(usage.userId));

describe("confirmed usage accounting", () => {
  it("invalidates a previously admitted quota after the debit commits", async () => {
    await expect(assertQuotaAvailable(usage.userId)).resolves.toBeUndefined();

    await recordAiUsage(usage);

    expect(state.creditsUsed).toBe(1);
    await expect(assertQuotaAvailable(usage.userId)).rejects.toMatchObject({ statusCode: 402 });
  });

  it("does not debit a replay of the same event", async () => {
    await recordAiUsage(usage);
    await recordAiUsage(usage);

    expect(state.events.size).toBe(1);
    expect(state.aggregateWrites).toBe(1);
    expect(state.creditsUsed).toBe(1);
  });

  it("rejects a reused event ID with a different operation", async () => {
    await recordAiUsage(usage);

    await expect(recordAiUsage({ ...usage, operation: "other" })).rejects.toThrow("usage_event_conflict");
    expect(state.creditsUsed).toBe(1);
  });

  it("rejects a reused event ID with a different conversation", async () => {
    await recordAiUsage(usage);

    await expect(recordAiUsage({ ...usage, conversationId: "thread-2" })).rejects.toThrow("usage_event_conflict");
    expect(state.creditsUsed).toBe(1);
  });

  it("recovers a concurrent identical event after the unique-key race", async () => {
    await Promise.all([recordAiUsage(usage), recordAiUsage(usage)]);

    expect(state.events.size).toBe(1);
    expect(state.aggregateWrites).toBe(1);
    expect(state.creditsUsed).toBe(1);
  });

  it("does not report committed usage as failed when realtime notification fails", async () => {
    vi.mocked(syncCreditsUpdate).mockImplementationOnce(() => { throw new Error("socket unavailable"); });

    await expect(recordAiUsage(usage)).resolves.toBeUndefined();

    expect(state.events.size).toBe(1);
    expect(state.creditsUsed).toBe(1);
  });
});
