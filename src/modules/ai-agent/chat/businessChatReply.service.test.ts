import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeBusinessChatReply, prepareAgentParams } from "./businessChatReply.service";
import { filterEligibleExternalDataSources } from "./externalToolEligibility";
import { buildSystemPrompt } from "../../meta/core/prompt.service";
import { enqueueCustomerMemoryCapture } from "@modules/meta/core/meta.queue";
import { runAgentGraph } from "@modules/ai-agent/core/agentGraph";

vi.mock("../rag/rag.service", () => ({
  retrieveRelevantChunksWithEmbedding: vi.fn().mockResolvedValue({
    chunks: [{ chunkType: "identity", content: "Business: pagesPilot" }],
    queryEmbedding: [0.1, 0.2, 0.3],
  }),
}));

vi.mock("../../meta/core/prompt.service", () => ({
  buildSystemPrompt: vi.fn().mockReturnValue("system prompt"),
}));

vi.mock("@modules/ai-agent/core/agentGraph", () => ({
  runAgentGraph: vi.fn(async () => ({
    action: "REPLY_AUTO",
    reasoning: "ok",
    content: "reply",
    requiresGrounding: false,
    grounded: false,
    usedChunkTypes: [],
  })),
}));

vi.mock("@modules/meta/core/meta.queue", () => ({
  enqueueCustomerMemoryCapture: vi.fn(async () => undefined),
}));

vi.mock("@config/prisma", () => ({
  default: {
    businessProfileMedia: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  },
}));

vi.mock("./externalToolEligibility", () => ({
  filterEligibleExternalDataSources: vi.fn(),
}));

vi.mock("@modules/integrations/external/externalActionSemanticIndex.service", () => ({
  ensureExternalActionSemanticIndexes: vi.fn(async () => undefined),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const priceSource = {
  id: 2,
  businessProfileId: 1,
  name: "product subscriptions price",
  description: "fetch only if user ask about the price",
  isActive: true,
  method: "GET",
  url: "https://example.com/prices",
  headers: null,
  queryParams: null,
  expectedParamsSchema: null,
  trigger: "CHAT_REQUESTED",
  routingMode: "STRICT",
} as any;

const businessProfile = {
  id: 1,
  userId: 1,
  name: "pagesPilot",
  identity: "AI content automation platform",
  voice: "Egyptian Arabic",
  tone: "Inspirational",
  customerDetailsInstructions: null,
  aiBehaviorInstructions: null,
  ragIngested: true,
  externalDataSources: [priceSource],
} as any;

describe("prepareAgentParams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not expose customer memory saving in the main chat tool path", async () => {
    vi.mocked(filterEligibleExternalDataSources).mockResolvedValue([priceSource]);

    const result = await prepareAgentParams({
      businessProfile,
      messageText: "what are the prices",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools).toEqual([
      {
        functionDeclarations: [
          expect.objectContaining({
            name: "integration_action_2",
            description: expect.stringContaining("queues the check in the background"),
            parameters: expect.objectContaining({
              type: "OBJECT",
              properties: {},
            }),
          }),
        ],
      },
    ]);
    expect(buildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "web",
        hasCustomerMemoryTool: false,
        hasChatRequestedActions: true,
        hasMediaAssets: false,
        hasCompletedActionResult: false,
      }),
    );
    expect(filterEligibleExternalDataSources).toHaveBeenCalledWith(
      [priceSource],
      "what are the prices",
      expect.objectContaining({
        businessProfileId: 1,
        queryEmbedding: [0.1, 0.2, 0.3],
      }),
    );
  });

  it("has no tools when no chat-requested action is eligible", async () => {
    vi.mocked(filterEligibleExternalDataSources).mockResolvedValue([]);

    const result = await prepareAgentParams({
      businessProfile,
      messageText: "hi",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools).toBeUndefined();
  });

  it("skips the external router when the profile has no active external sources", async () => {
    const result = await prepareAgentParams({
      businessProfile: {
        ...businessProfile,
        externalDataSources: [],
      },
      messageText: "hi",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools).toBeUndefined();
    expect(filterEligibleExternalDataSources).not.toHaveBeenCalled();
  });

  it("does not expose non-chat action schemas as customer memory tools", async () => {
    const futureEventAction = {
      ...priceSource,
      id: 9,
      trigger: "CUSTOMER_DETAILS_SAVED",
      expectedParamsSchema: {
        interest: {
          type: "STRING",
          source: "USER_PROVIDED",
          required: true,
          description: "Customer interest",
        },
      },
      isActive: true,
    };

    const result = await prepareAgentParams({
      businessProfile: {
        ...businessProfile,
        externalDataSources: [{ ...priceSource, isActive: false }, futureEventAction],
      },
      messageText: "I want a callback",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools).toBeUndefined();
    expect(filterEligibleExternalDataSources).not.toHaveBeenCalled();
  });

  it("enqueues customer memory capture after the main reply without exposing a save tool", async () => {
    vi.mocked(filterEligibleExternalDataSources).mockResolvedValue([]);

    const reply = await computeBusinessChatReply({
      businessProfile,
      messageText: "يا ريت ابعتيلي رقم ٢",
      historyTurns: [{ role: "user", text: "علم النفس" }],
      channel: "whatsapp",
      customerPhone: "201202840018",
      conversationId: 172,
    });

    expect(reply.content).toBe("reply");
    expect(runAgentGraph).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: undefined,
        customerPhone: "201202840018",
      }),
    );
    expect(enqueueCustomerMemoryCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        businessProfileId: 1,
        conversationId: 172,
        channel: "whatsapp",
        customerPhone: "201202840018",
        latestUserText: "يا ريت ابعتيلي رقم ٢",
        recentTurns: [{ role: "user", text: "علم النفس" }],
      }),
    );
  });
});
