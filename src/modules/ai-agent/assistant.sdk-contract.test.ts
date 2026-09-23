import { Client } from "@langchain/langgraph-sdk";
import { describe, expect, it, vi } from "vitest";

describe("LangGraph SDK wire contract", () => {
  it("serializes official history pagination with only a scalar checkpoint cursor", async () => {
    const request = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
      Response.json([]),
    );
    const client = new Client({
      apiUrl: "https://agent.test",
      callerOptions: { fetch: request, maxRetries: 0 },
    });

    await client.threads.getHistory("thread-1", {
      limit: 100,
      before: { configurable: { checkpoint_id: "cp-older" } },
    });

    const init = request.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      limit: 100,
      before: { configurable: { checkpoint_id: "cp-older" } },
    });
  });

  it("serializes checkpointId as scalar checkpoint_id", async () => {
    const request = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Response("", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }));
    const client = new Client({
      apiUrl: "https://agent.test",
      callerOptions: { fetch: request, maxRetries: 0 },
    });

    for await (const _event of client.runs.stream("thread-1", "agent", {
      input: null,
      checkpointId: "cp-123",
      streamMode: ["messages", "updates", "custom"],
    })) {
      // Empty test stream.
    }

    const init = request.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      assistant_id: "agent",
      input: null,
      checkpoint_id: "cp-123",
    });
    expect(body).not.toHaveProperty("checkpoint");
  });
});
