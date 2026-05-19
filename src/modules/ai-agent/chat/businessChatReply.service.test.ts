import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeBusinessChatReply, prepareAgentParams } from "./businessChatReply.service";
import { filterEligibleAgentActionSources } from "./externalToolEligibility";
import { buildSystemPrompt } from "../../meta/core/prompt.service";
import { enqueueCustomerMemoryCapture } from "@modules/meta/core/meta.queue";
import { runAgentGraphV2 } from "@modules/ai-agent/core/agentGraphV2";
import { retrieveRelevantChunksWithEmbedding } from "../rag/rag.service";

vi.mock("../rag/rag.service", () => ({
  retrieveRelevantChunksWithEmbedding: vi.fn().mockResolvedValue({
    chunks: [{ chunkType: "identity", content: "Business: pagesPilot" }],
    queryEmbedding: [0.1, 0.2, 0.3],
  }),
}));

vi.mock("../../meta/core/prompt.service", () => ({
  buildSystemPrompt: vi.fn().mockReturnValue("system prompt"),
}));

vi.mock("@modules/ai-agent/core/agentGraphV2", () => ({
  runAgentGraphV2: vi.fn(async () => ({
    action: "REPLY_AUTO",
    reasoning: "ok",
    content: "reply",
    requiresGrounding: false,
    grounded: false,
    usedChunkTypes: [],
  })),
}));

vi.mock("@modules/ai-agent/core/agentTurn.service", () => ({
  createAgentTurn: vi.fn(async () => ({ id: 999 })),
  updateAgentTurnStatus: vi.fn(async () => undefined),
}));

vi.mock("@modules/meta/core/meta.queue", () => ({
  enqueueCustomerMemoryCapture: vi.fn(async () => undefined),
}));

vi.mock("@config/prisma", () => ({
  default: {
    businessProfileMedia: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    integrationActionRun: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock("./externalToolEligibility", () => ({
  filterEligibleAgentActionSources: vi.fn(),
}));

vi.mock("@modules/integrations/external/agentActionSemanticIndex.service", () => ({
  ensureExternalActionSemanticIndexes: vi.fn(async () => undefined),
}));

vi.mock("@modules/integrations/external/agentActionWorkflow.service", () => ({
  listActiveAgentActionWorkflows: vi.fn(async () => []),
  activeWorkflowSourceIds: vi.fn(() => new Set()),
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
  actionType: "LOOKUP",
  routingMode: "STRICT",
} as any;

const leadCaptureSource = {
  ...priceSource,
  id: 7,
  name: "capture and send leads to the crm",
  description: "use after the customer confirms registration and provides program data",
  method: "POST",
  actionType: "MUTATION",
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
  agentActionSources: [priceSource],
} as any;

describe("prepareAgentParams", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not expose customer memory saving in the main chat tool path", async () => {
    vi.mocked(filterEligibleAgentActionSources).mockResolvedValue([priceSource]);

    const result = await prepareAgentParams({
      businessProfile,
      messageText: "what are the prices",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools).toHaveLength(1);
    expect(result.graphParams?.tools?.[0]).toMatchObject({
      name: "integration_action_2",
      description: expect.stringContaining("queues the check in the background"),
    });
    expect(result.graphParams?.tools?.[0].schema.safeParse({}).success).toBe(true);
    expect(buildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "web",
        hasChatRequestedActions: true,
        hasMediaAssets: false,
        hasCompletedActionResult: false,
      }),
    );
    expect(filterEligibleAgentActionSources).toHaveBeenCalledWith(
      [priceSource],
      "what are the prices",
      expect.objectContaining({
        businessProfileId: 1,
        queryEmbedding: [0.1, 0.2, 0.3],
      }),
    );
  });

  it("has no tools when no chat-requested action is eligible", async () => {
    vi.mocked(filterEligibleAgentActionSources).mockResolvedValue([]);

    const result = await prepareAgentParams({
      businessProfile,
      messageText: "hi",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools).toBeUndefined();
  });

  it("skips Agent Action routing when the profile has no active action sources", async () => {
    const result = await prepareAgentParams({
      businessProfile: {
        ...businessProfile,
        agentActionSources: [],
      },
      messageText: "hi",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools).toBeUndefined();
    expect(filterEligibleAgentActionSources).not.toHaveBeenCalled();
  });

  it("uses media understanding text as the model and retrieval query", async () => {
    const result = await prepareAgentParams({
      businessProfile: {
        ...businessProfile,
        agentActionSources: [],
      },
      messageText: "",
      mediaInfo: {
        id: "wamid.image.1",
        type: "image",
        metadata: {
          mimeType: "image/jpeg",
          analysis: {
            status: "completed",
            text: "The customer sent a certificate photo.",
          },
        },
      },
      historyTurns: [],
      channel: "whatsapp",
    });

    expect(retrieveRelevantChunksWithEmbedding).toHaveBeenCalledWith(
      1,
      expect.stringContaining("certificate photo"),
      5,
    );
    expect(result.graphParams?.customerMessage).toContain("certificate photo");
  });

  it("does not expose non-chat action schemas", async () => {
    const futureEventAction = {
      ...priceSource,
      id: 9,
      trigger: "NOT_CHAT_REQUESTED" as any,
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
        agentActionSources: [{ ...priceSource, isActive: false }, futureEventAction],
      },
      messageText: "I want a callback",
      historyTurns: [],
      channel: "web",
    });

    expect(result.graphParams?.tools).toBeUndefined();
    expect(filterEligibleAgentActionSources).not.toHaveBeenCalled();
  });

  it("can expose a different action after a completed helper action result", async () => {
    vi.mocked(filterEligibleAgentActionSources).mockResolvedValue([leadCaptureSource]);
    const originalRequest =
      "ايوه احجز مكان في الدفعه الجديده كورس علم النفس بالفنون";

    const result = await prepareAgentParams({
      businessProfile: {
        ...businessProfile,
        agentActionSources: [priceSource, leadCaptureSource],
      },
      messageText:
        `The queued external action for the customer's request has completed. Original customer request: ${originalRequest}`,
      historyTurns: [],
      channel: "whatsapp",
      customerPhone: "201202840018",
      completedExternalLookup: {
        sourceName: "courses or programs",
        toolName: "integration_action_2",
        envelope: {
          success: true,
          verification: "verified",
          actionType: "integration_action_2",
          reason: "data_returned",
          data: { courses: [{ title: "الدعم النفسى بالفنون", availableSeats: 5 }] },
        },
      },
      allowedActionSourceIds: [leadCaptureSource.id],
    });

    expect(retrieveRelevantChunksWithEmbedding).toHaveBeenCalledWith(
      1,
      originalRequest,
      5,
    );
    expect(filterEligibleAgentActionSources).not.toHaveBeenCalled();
    expect(result.graphParams?.tools).toHaveLength(1);
    expect(result.graphParams?.tools?.[0]).toMatchObject({
      name: "integration_action_7",
      description: expect.stringContaining("queues the action in the background"),
    });
    expect(buildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        hasChatRequestedActions: true,
        hasCompletedActionResult: true,
      }),
    );
    expect(result.graphParams?.systemInstruction).toContain(
      "verified lookup/helper result",
    );
  });

  it("does not expose more actions after a failed completed action result", async () => {
    const result = await prepareAgentParams({
      businessProfile: {
        ...businessProfile,
        agentActionSources: [priceSource, leadCaptureSource],
      },
      messageText: "كورس علم النفس بالفنون\nالاسم هشام \nرقم الموبايل 01202840018",
      historyTurns: [],
      channel: "messenger",
      completedExternalLookup: {
        sourceName: "capture and send leads to the crm",
        toolName: "integration_action_7",
        envelope: {
          success: false,
          verification: "failed",
          actionType: "integration_action_7",
          reason: "non_retryable_http_422",
          data: null,
          error: "External API returned status 422",
        },
      },
    });

    expect(filterEligibleAgentActionSources).not.toHaveBeenCalled();
    expect(result.graphParams?.tools).toBeUndefined();
    expect(buildSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        hasChatRequestedActions: false,
        hasCompletedActionResult: true,
      }),
    );
    expect(result.graphParams?.systemInstruction).toContain(
      "<reply_policy>",
    );
    expect(result.graphParams).toMatchObject({
      replyPolicy: expect.objectContaining({
        allowedActions: ["REPLY_AUTO"],
        allowedReplyTypes: ["ASK_FOR_CORRECTION"],
        requiresCustomerCorrection: true,
        canConfirmActionSuccess: false,
      }),
    });
    expect(result.graphParams?.systemInstruction).toContain(
      '"reason": "action_validation_failed"',
    );
    expect(result.graphParams?.systemInstruction).not.toContain("422");
    expect(result.graphParams?.systemInstruction).not.toContain("External API");
  });

  it("does not enqueue customer memory capture for internal completed-action turns", async () => {
    vi.mocked(filterEligibleAgentActionSources).mockResolvedValue([]);

    await computeBusinessChatReply({
      businessProfile,
      messageText:
        "The queued external action for the customer's request has completed. Original customer request: الدعم النفسي بالفنون",
      historyTurns: [],
      channel: "whatsapp",
      customerPhone: "201202840018",
      conversationId: 172,
      completedExternalLookup: {
        sourceName: "courses or programs",
        toolName: "integration_action_2",
        envelope: {
          success: true,
          verification: "verified",
          actionType: "integration_action_2",
          reason: "data_returned",
          data: { courses: [{ title: "الدعم النفسى بالفنون" }] },
        },
      },
    });

    expect(enqueueCustomerMemoryCapture).not.toHaveBeenCalled();
  });

  it("enqueues customer memory capture after the main reply without exposing a save tool", async () => {
    vi.mocked(filterEligibleAgentActionSources).mockResolvedValue([]);

    const reply = await computeBusinessChatReply({
      businessProfile,
      messageText: "يا ريت ابعتيلي رقم ٢",
      historyTurns: [{ role: "user", text: "علم النفس" }],
      channel: "whatsapp",
      customerPhone: "201202840018",
      conversationId: 172,
    });

    expect(reply.content).toBe("reply");
    expect(runAgentGraphV2).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: undefined,
        customerPhone: "201202840018",
        agentTurnId: 999,
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

  it("continues a failed mutation workflow with the same verified lookup context", async () => {
    const prisma = (await import("@config/prisma")).default as any;
    prisma.integrationActionRun.findFirst
      .mockResolvedValueOnce({
        id: 88,
        sourceId: leadCaptureSource.id,
        workflowId: 12,
        parentRunId: 77,
        createdAt: new Date(),
        source: leadCaptureSource,
        workflow: {
          mutationSourceId: leadCaptureSource.id,
          mutationSource: leadCaptureSource,
        },
        parentRun: {
          sourceId: priceSource.id,
          toolName: "integration_action_2",
          source: priceSource,
          responsePayload: {
            success: true,
            verification: "verified",
            actionType: "integration_action_2",
            reason: "data_returned",
            data: { courses: [{ title: "الدعم النفسى بالفنون" }] },
          },
        },
      })
      .mockResolvedValueOnce(null);

    vi.mocked(filterEligibleAgentActionSources).mockResolvedValue([leadCaptureSource]);

    await computeBusinessChatReply({
      businessProfile: {
        ...businessProfile,
        agentActionSources: [priceSource, leadCaptureSource],
      },
      messageText: "رقمي الصحيح 01020304050",
      historyTurns: [
        { role: "user", text: "عاوز احجز الدعم النفسى بالفنون" },
        { role: "model", text: "ابعتلي الرقم الصحيح" },
      ],
      channel: "messenger",
      conversationId: 172,
    });

    expect(filterEligibleAgentActionSources).not.toHaveBeenCalled();
    expect(runAgentGraphV2).toHaveBeenCalledWith(
      expect.objectContaining({
        activeWorkflowId: 12,
        parentActionRunId: 77,
        actionStepKey: "mutation",
        tools: [
          expect.objectContaining({ name: "integration_action_7" }),
        ],
      }),
    );
  });
});
