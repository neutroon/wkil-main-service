import { beforeEach, describe, expect, it, vi } from "vitest";

const runsCreateMock = vi.hoisted(() => vi.fn());
const runsJoinMock = vi.hoisted(() => vi.fn());
const runsGetMock = vi.hoisted(() => vi.fn());
const runsCancelMock = vi.hoisted(() => vi.fn());
const threadsCreateMock = vi.hoisted(() => vi.fn(async () => ({ thread_id: "thread-1" })));
const clientConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("@langchain/langgraph-sdk", () => ({
  Client: class {
    threads = { create: threadsCreateMock };
    runs = { create: runsCreateMock, join: runsJoinMock, get: runsGetMock, cancel: runsCancelMock };
    constructor(config: unknown) { clientConstructorMock(config); }
  },
}));

import { AgentClient } from "./agent.client";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MONOLITH_AGENT_API_KEY = "internal-service-key";
  process.env.USE_AGENT_SERVICE = "true";
  runsCreateMock.mockResolvedValue({
    run_id: "run-1", thread_id: "thread-1", assistant_id: "capability", status: "pending",
    created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z",
    metadata: {}, multitask_strategy: null,
  });
  runsJoinMock.mockResolvedValue({ result: { content: "completed output" } });
  runsGetMock.mockResolvedValue({ status: "success" });
});

describe("AgentClient", () => {
  it("is disabled when USE_AGENT_SERVICE is off", () => {
    process.env.USE_AGENT_SERVICE = "false";
    expect(AgentClient.enabled()).toBe(false);
  });

  it("waits for a pending SDK run and returns the completed typed result", async () => {
    const output = await AgentClient.runCapability({
      userId: 7,
      businessProfileId: 10,
      operation: "follow_up",
      context: {
        business: { name: "Academy" },
        conversation: { channel: "whatsapp" },
        history: [{ role: "customer", content: "عاوز تفاصيل" }],
        delayIndex: 0,
      },
    });

    expect(output).toEqual({ content: "completed output" });
    expect(runsCreateMock).toHaveBeenCalledWith("thread-1", "capability", {
      input: {
        user_id: 7,
        business_profile_id: 10,
        operation: "follow_up",
        context: {
          business: { name: "Academy" },
          conversation: { channel: "whatsapp" },
          history: [{ role: "customer", content: "عاوز تفاصيل" }],
          delay_index: 0,
        },
      },
    });
    expect(runsJoinMock).toHaveBeenCalledWith(
      "thread-1", "run-1", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(runsGetMock).toHaveBeenCalledWith(
      "thread-1", "run-1", expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each(["interrupted", "error", "timeout"] as const)(
    "rejects a %s run instead of consuming partial state",
    async (status) => {
      runsGetMock.mockResolvedValueOnce({ status });
      await expect(AgentClient.runCapability({
        userId: 7,
        businessProfileId: 10,
        operation: "customer_memory",
        context: {
          latestCustomerMessage: "اسمي سلمى",
          recentMessages: [{ role: "customer", text: "اسمي سلمى" }],
          business: { name: "Academy" },
        },
      })).rejects.toThrow(`Agent capability run ${status}`);
    },
  );

  it("rejects a successful run with no graph result", async () => {
    runsJoinMock.mockResolvedValueOnce({ operation: "follow_up" });
    await expect(AgentClient.runCapability({
      userId: 7,
      businessProfileId: 10,
      operation: "follow_up",
      context: {
        business: { name: "Academy" }, conversation: { channel: "web" },
        history: [{ role: "customer", content: "hello" }], delayIndex: 0,
      },
    })).rejects.toThrow("missing a result");
  });

  it("uses only the backend service caller key", async () => {
    process.env.LANGGRAPH_API_KEY = "browser-bff-key";
    await AgentClient.runCapability({
      userId: 7, businessProfileId: 10, operation: "business_identity",
      context: { markdown: "# Academy" },
    });
    expect(clientConstructorMock).toHaveBeenCalledWith({
      apiUrl: expect.any(String), apiKey: "internal-service-key",
    });
  });

  it("projects profile payloads onto the strict business capability contract", async () => {
    runsJoinMock.mockResolvedValueOnce({ result: { action: "REPLY_AUTO", content: "ok" } });
    await AgentClient.runCapability({
      userId: 7, businessProfileId: 10, operation: "customer_reply",
      context: {
        channel: "web", messageText: "hello", conversationId: 4,
        business: {
          id: 10, userId: 7, name: "Academy", voice: "Warm", tone: "Calm",
          targetAudience: "Parents", productsServices: ["Classes"],
          internalSecret: "must-not-reach-agent",
        },
      },
    });
    expect(runsCreateMock).toHaveBeenCalledWith("thread-1", "capability", expect.objectContaining({
      input: expect.objectContaining({
        context: expect.objectContaining({
          business: {
            name: "Academy", voice: "Warm", tone: "Calm",
            target_audience: "Parents", products_services: ["Classes"],
          },
        }),
      }),
    }));
  });
});
