import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordUsageNode } from "./recordUsage";
import { enqueueAiUsageRecord } from "@modules/billing/billing.queue";
import { recordAiUsage } from "@modules/billing/billing.service";

vi.mock("@modules/billing/billing.queue", () => ({
  enqueueAiUsageRecord: vi.fn(),
}));

vi.mock("@modules/billing/billing.service", () => ({
  recordAiUsage: vi.fn(),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const baseState = {
  userId: 10,
  businessProfileId: 20,
  channel: "whatsapp",
  agentTurnId: 30,
  sessionStats: {
    promptTokens: 120,
    completionTokens: 35,
    groundingCalls: 0,
    lastBilledPromptTokens: 20,
    lastBilledCompletionTokens: 5,
    lastBilledGrounding: 0,
    modelName: "gemini-3-flash-preview",
  },
} as any;

describe("recordUsageNode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("schedules usage recording without waiting for the billing queue", async () => {
    let resolveQueue: (() => void) | undefined;
    vi.mocked(enqueueAiUsageRecord).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveQueue = resolve;
      }) as any,
    );

    await expect(recordUsageNode(baseState)).resolves.toEqual({});

    expect(enqueueAiUsageRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 10,
        businessProfileId: 20,
        promptTokens: 100,
        completionTokens: 30,
        operation: "chat_whatsapp",
      }),
      expect.objectContaining({
        jobId: "ai-usage-terminal-30-gemini-3-flash-preview-100-30-0",
      }),
    );
    expect(recordAiUsage).not.toHaveBeenCalled();

    resolveQueue?.();
  });

  it("falls back to direct usage recording in the background when enqueue fails", async () => {
    vi.mocked(enqueueAiUsageRecord).mockRejectedValueOnce(
      new Error("queue unavailable"),
    );
    vi.mocked(recordAiUsage).mockResolvedValueOnce(undefined as any);

    await recordUsageNode(baseState);

    await vi.waitFor(() => {
      expect(recordAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          businessProfileId: 20,
          promptTokens: 100,
          completionTokens: 30,
        }),
      );
    });
  });
});
