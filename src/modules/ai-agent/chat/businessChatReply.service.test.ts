import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAgentParams } from "./businessChatReply.service";
import { filterEligibleExternalDataSources } from "./externalToolEligibility";
import { buildSystemPrompt } from "../../meta/core/prompt.service";

vi.mock("../rag/rag.service", () => ({
  retrieveRelevantChunks: vi.fn().mockResolvedValue([
    { chunkType: "identity", content: "Business: pagesPilot" },
  ]),
}));

vi.mock("../../meta/core/prompt.service", () => ({
  buildSystemPrompt: vi.fn().mockReturnValue("system prompt"),
}));

vi.mock("@modules/ai-agent/core/agentGraph", () => ({
  runAgentGraph: vi.fn(),
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
  crmIntegrations: [],
} as any;

describe("prepareAgentParams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always exposes customer details saving and merges router-approved external sources", async () => {
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
            name: "save_customer_details",
            parameters: expect.objectContaining({
              type: "OBJECT",
              properties: expect.objectContaining({
                name: expect.any(Object),
                phone: expect.any(Object),
                email: expect.any(Object),
                notes: expect.any(Object),
              }),
            }),
          }),
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
        hasCustomerMemoryTool: true,
        hasChatRequestedActions: true,
        hasMediaAssets: false,
        hasCompletedActionResult: false,
      }),
    );
  });

  it("keeps customer details saving available when no external source is eligible", async () => {
    vi.mocked(filterEligibleExternalDataSources).mockResolvedValue([]);

    const result = await prepareAgentParams({
      businessProfile,
      messageText: "hi",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools?.[0].functionDeclarations).toEqual([
      expect.objectContaining({ name: "save_customer_details" }),
    ]);
  });

  it("skips the external router when the profile has no active external sources", async () => {
    const result = await prepareAgentParams({
      businessProfile: {
        ...businessProfile,
        externalDataSources: [],
        crmIntegrations: [],
      },
      messageText: "hi",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools?.[0].functionDeclarations).toEqual([
      expect.objectContaining({ name: "save_customer_details" }),
    ]);
    expect(filterEligibleExternalDataSources).not.toHaveBeenCalled();
  });

  it("keeps customer memory independent from non-chat action schemas", async () => {
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
        crmIntegrations: [],
      },
      messageText: "I want a callback",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools?.[0].functionDeclarations).toEqual([
      expect.objectContaining({
        name: "save_customer_details",
        parameters: expect.objectContaining({
          properties: expect.not.objectContaining({
            interest: expect.any(Object),
          }),
        }),
      }),
    ]);
    expect(filterEligibleExternalDataSources).not.toHaveBeenCalled();
  });
});
