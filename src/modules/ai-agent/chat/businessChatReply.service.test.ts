import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareAgentParams } from "./businessChatReply.service";
import { filterEligibleExternalDataSources } from "./externalToolEligibility";
import { shouldExposeCrmTool } from "./crmToolEligibility";
import { buildSystemPrompt } from "../../meta/core/prompt.service";

vi.mock("../rag/rag.service", () => ({
  retrieveRelevantChunks: vi.fn().mockResolvedValue([
    { chunkType: "identity", content: "Business: pagesPilot" },
  ]),
}));

vi.mock("../../meta/core/prompt.service", () => ({
  buildSystemPrompt: vi.fn().mockReturnValue("system prompt"),
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

vi.mock("./crmToolEligibility", () => ({
  shouldExposeCrmTool: vi.fn(),
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
  routingMode: "STRICT",
} as any;

const businessProfile = {
  id: 1,
  userId: 1,
  name: "pagesPilot",
  identity: "AI content automation platform",
  voice: "Egyptian Arabic",
  tone: "Inspirational",
  leadCaptureInstructions: null,
  aiBehaviorInstructions: null,
  ragIngested: true,
  externalDataSources: [priceSource],
  crmIntegrations: [],
} as any;

describe("prepareAgentParams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(shouldExposeCrmTool).mockResolvedValue(false);
  });

  it("passes router-approved external sources into the final Gemini tool declarations", async () => {
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
            name: "query_external_api_2",
            parameters: expect.objectContaining({
              type: "OBJECT",
              properties: {},
            }),
          }),
        ],
      },
    ]);
  });

  it("leaves Gemini tools undefined when no CRM or external source is eligible", async () => {
    vi.mocked(filterEligibleExternalDataSources).mockResolvedValue([]);

    const result = await prepareAgentParams({
      businessProfile,
      messageText: "hi",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools).toBeUndefined();
  });

  it("skips CRM and external routers when the profile has no active tools", async () => {
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

    expect(result.graphParams?.tools).toBeUndefined();
    expect(shouldExposeCrmTool).not.toHaveBeenCalled();
    expect(filterEligibleExternalDataSources).not.toHaveBeenCalled();
  });

  it("treats inactive tools as nonexistent for routers and prompt CRM fields", async () => {
    const inactiveCrm = {
      id: 9,
      provider: "webhook",
      isActive: false,
      fieldMapping: {
        interest: {
          type: "STRING",
          source: "USER_PROVIDED",
          required: true,
          description: "Customer interest",
        },
      },
    };

    const result = await prepareAgentParams({
      businessProfile: {
        ...businessProfile,
        externalDataSources: [{ ...priceSource, isActive: false }],
        crmIntegrations: [inactiveCrm],
      },
      messageText: "I want a callback",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools).toBeUndefined();
    expect(shouldExposeCrmTool).not.toHaveBeenCalled();
    expect(filterEligibleExternalDataSources).not.toHaveBeenCalled();
    const promptCalls = vi.mocked(buildSystemPrompt).mock.calls;
    expect(promptCalls[promptCalls.length - 1]?.[0]).toMatchObject({
      crmFields: [],
    });
  });
});
