import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertLatestConversationAiRun,
  isLatestConversationAiRun,
  startConversationAiRun,
  StaleConversationRunError,
} from "./conversationRunGuard";

vi.mock("@utils/cache", () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@config/prisma", () => ({
  default: {
    conversationMessage: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("conversation AI run guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks an older run stale when another run is active", async () => {
    const { cache } = await import("@utils/cache");
    vi.mocked(cache.get).mockResolvedValue({
      runId: "newer-run",
      latestUserMessageId: 2,
      startedAt: new Date().toISOString(),
    });

    const run = {
      conversationId: 9,
      runId: "older-run",
      latestUserMessageId: 1,
      startedAt: new Date().toISOString(),
    };

    await expect(
      assertLatestConversationAiRun(run, "before_reply_save"),
    ).rejects.toBeInstanceOf(StaleConversationRunError);
  });

  it("falls back to the database if the active run token is unavailable", async () => {
    const { cache } = await import("@utils/cache");
    const prisma = (await import("@config/prisma")).default as any;
    vi.mocked(cache.get).mockResolvedValue(null);
    prisma.conversationMessage.findFirst.mockResolvedValue(null);

    const run = await startConversationAiRun({
      conversationId: 9,
      latestUserMessageId: 3,
    });

    await expect(isLatestConversationAiRun(run)).resolves.toBe(true);
  });
});
