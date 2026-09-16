import { beforeEach, describe, expect, it, vi } from "vitest";

const runsCreateMock = vi.hoisted(() => vi.fn());
const runsJoinMock = vi.hoisted(() => vi.fn());
const runsGetMock = vi.hoisted(() => vi.fn());
const runsCancelMock = vi.hoisted(() => vi.fn());
const runsListMock = vi.hoisted(() => vi.fn());
const runsJoinStreamMock = vi.hoisted(() => vi.fn());
const threadsCreateMock = vi.hoisted(() => vi.fn(async () => ({ thread_id: "thread-1" })));
const threadsGetStateMock = vi.hoisted(() => vi.fn());
const clientConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("@langchain/langgraph-sdk", () => ({
  Client: class {
    threads = { create: threadsCreateMock, getState: threadsGetStateMock };
    runs = {
      create: runsCreateMock,
      join: runsJoinMock,
      get: runsGetMock,
      cancel: runsCancelMock,
      list: runsListMock,
      joinStream: runsJoinStreamMock,
    };
    constructor(config: unknown) { clientConstructorMock(config); }
  },
}));

import { AgentClient } from "./agent.client";

beforeEach(() => {
  vi.resetAllMocks();
  process.env.MONOLITH_AGENT_API_KEY = "internal-service-key";
  process.env.USE_AGENT_SERVICE = "true";
  runsCreateMock.mockResolvedValue({
    run_id: "run-1", thread_id: "thread-1", assistant_id: "capability", status: "pending",
    created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z",
    metadata: {}, multitask_strategy: null,
  });
  runsJoinMock.mockResolvedValue({ result: { content: "completed output" } });
  runsGetMock.mockResolvedValue({ status: "success" });
  runsCancelMock.mockResolvedValue(undefined);
  threadsGetStateMock.mockResolvedValue({ values: { messages: [] } });
  runsListMock.mockResolvedValue([]);
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

  it("creates a caller-selected customer thread idempotently", async () => {
    await AgentClient.ensureCustomerThread("11111111-1111-4111-8111-111111111111", {
      businessProfileId: 10,
      conversationId: 45,
      channel: "whatsapp",
    });

    expect(threadsCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "11111111-1111-4111-8111-111111111111",
      ifExists: "do_nothing",
      graphId: "customer_agent",
      ttl: { ttl: 90 * 24 * 60, strategy: "delete" },
      metadata: {
        business_profile_id: 10,
        conversation_id: 45,
        channel: "whatsapp",
      },
    }));
  });

  it("starts an ordered durable run on the existing thread", async () => {
    await AgentClient.startCustomerRun({
      threadId: "11111111-1111-4111-8111-111111111111",
      messages: [{ role: "user", content: "Hello" }],
      context: {
        userId: 7, businessProfileId: 10, conversationId: 45,
        channel: "whatsapp", runMode: "inbound",
        mediaContext: "Customer attached an image.", followUpIndex: 2,
      },
      dedupeKey: "message:99",
    });

    expect(runsCreateMock).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      "customer_agent",
      expect.objectContaining({
        input: {
          messages: [{ role: "user", content: "Hello" }],
          user_id: 7,
          business_profile_id: 10,
          conversation_id: 45,
          channel: "whatsapp",
          run_mode: "inbound",
          media_context: "Customer attached an image.",
          follow_up_index: 2,
        },
        multitaskStrategy: "enqueue",
        durability: "async",
        config: { recursion_limit: 6 },
        metadata: expect.objectContaining({ dedupe_key: "message:99" }),
      }),
    );
  });

  it("finds the newest exact dedupe match regardless of SDK list order", async () => {
    runsListMock.mockResolvedValueOnce([
      {
        run_id: "old", created_at: "2026-09-05T00:01:00Z",
        metadata: { dedupe_key: "message:99" },
      },
      {
        run_id: "newest", created_at: "2026-09-05T00:02:00Z",
        metadata: { dedupe_key: "message:99" },
      },
      {
        run_id: "other", created_at: "2026-09-05T00:03:00Z",
        metadata: { dedupe_key: "message:98" },
      },
    ]);

    await expect(AgentClient.findCustomerRunByDedupeKey("thread-1", "message:99"))
      .resolves.toEqual({ runId: "newest" });
    expect(runsListMock).toHaveBeenCalledWith("thread-1", { limit: 100, offset: 0, signal: undefined });
  });

  it("searches later SDK run pages before declaring a crash-window run missing", async () => {
    runsListMock
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => ({
        run_id: `other-${index}`,
        metadata: { dedupe_key: "other" },
      })))
      .mockResolvedValueOnce([{ run_id: "later-match", metadata: { dedupe_key: "message:99" } }]);

    await expect(AgentClient.findCustomerRunByDedupeKey("thread-1", "message:99"))
      .resolves.toEqual({ runId: "later-match" });

    expect(runsListMock).toHaveBeenNthCalledWith(1, "thread-1", {
      limit: 100, offset: 0, signal: undefined,
    });
    expect(runsListMock).toHaveBeenNthCalledWith(2, "thread-1", {
      limit: 100, offset: 100, signal: undefined,
    });
  });

  it("uses a deterministic run id fallback for malformed customer-run timestamps", async () => {
    runsListMock.mockResolvedValueOnce([
      { run_id: "run-a", created_at: "not-a-date", metadata: { dedupe_key: "message:99" } },
      { run_id: "run-z", metadata: { dedupe_key: "message:99" } },
    ]);

    await expect(AgentClient.findCustomerRunByDedupeKey("thread-1", "message:99"))
      .resolves.toEqual({ runId: "run-z" });
  });

  it("reads customer thread state and exposes the official join stream", async () => {
    const stream = (async function* () { yield { event: "values", data: {} }; })();
    runsJoinStreamMock.mockReturnValueOnce(stream);

    await expect(AgentClient.getCustomerThreadState("thread-1")).resolves.toEqual({ messages: [] });
    expect(threadsGetStateMock).toHaveBeenCalledWith("thread-1", undefined, { signal: undefined });
    expect(AgentClient.joinCustomerRunStream("thread-1", "run-1", { cancelOnDisconnect: true }))
      .toBe(stream);
    expect(runsJoinStreamMock).toHaveBeenCalledWith("thread-1", "run-1", { cancelOnDisconnect: true });
  });

  it("cancels a customer run through the official interrupt operation", async () => {
    await AgentClient.cancelCustomerRun("thread-1", "run-1");
    expect(runsCancelMock).toHaveBeenCalledWith("thread-1", "run-1", true, "interrupt");
  });

  it("reads and validates the completed structured response", async () => {
    runsJoinMock.mockResolvedValueOnce({
      structured_response: {
        action: "HANDOFF",
        content: null,
        reason_code: "HUMAN_ACTION_REQUIRED",
        handoff_category: "SUPPORT",
      },
    });

    await expect(AgentClient.joinCustomerRun("thread-1", "run-1")).resolves.toEqual({
      action: "HANDOFF",
      content: null,
      reason_code: "HUMAN_ACTION_REQUIRED",
      handoff_category: "SUPPORT",
    });
  });

  it("rejects a terminal non-success customer run", async () => {
    runsGetMock.mockResolvedValueOnce({ status: "error" });

    await expect(AgentClient.joinCustomerRun("thread-1", "run-1"))
      .rejects.toThrow("Customer agent run error");
  });

  it("cancels a customer run if joining times out", async () => {
    vi.useFakeTimers();
    runsJoinMock.mockImplementationOnce(async (_threadId: string, _runId: string, options: { signal: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
      return {};
    });
    const pending = expect(AgentClient.joinCustomerRun("thread-1", "run-1"))
      .rejects.toThrow("Customer agent run timeout after 45000ms");
    await vi.advanceTimersByTimeAsync(45_000);
    await pending;
    expect(runsCancelMock).toHaveBeenCalledWith("thread-1", "run-1", true, "interrupt");
    vi.useRealTimers();
  });

  it("cancels a customer run on caller abort without reporting a timeout", async () => {
    const caller = new AbortController();
    runsJoinMock.mockImplementationOnce(async (_threadId: string, _runId: string, options: { signal: AbortSignal }) => {
      await new Promise<void>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
      return {};
    });

    const pending = AgentClient.joinCustomerRun("thread-1", "run-1", { signal: caller.signal });
    caller.abort("client disconnected");

    await expect(pending).rejects.toMatchObject({
      name: "CustomerAgentRunAbortedError",
      code: "CUSTOMER_AGENT_RUN_ABORTED",
      cause: "client disconnected",
    });
    expect(runsCancelMock).toHaveBeenCalledWith("thread-1", "run-1", true, "interrupt");
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

});
