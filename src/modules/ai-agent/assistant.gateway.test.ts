import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceAccess = vi.hoisted(() => ({
  getActiveProfileId: vi.fn(async () => 7),
  requireWorkspaceProfileAccess: vi.fn(),
}));

vi.mock("@modules/workspace/workspace.service", () => workspaceAccess);

import { assistantGateway, assistantGatewayInternals } from "./assistant.gateway";

const scope = { userId: 42, profileId: 7, workspaceId: 11 };

beforeEach(() => {
  vi.clearAllMocks();
  workspaceAccess.getActiveProfileId.mockResolvedValue(7);
  workspaceAccess.requireWorkspaceProfileAccess.mockResolvedValue({
    workspaceId: 11,
    role: "owner",
  });
});

describe("assistant gateway contract", () => {
  it.each([
    ["POST", ["threads"], "create"],
    ["POST", ["threads", "search"], "search"],
    ["GET", ["threads", "thread-1"], "read"],
    ["PATCH", ["threads", "thread-1"], "update"],
    ["DELETE", ["threads", "thread-1"], "delete"],
    ["GET", ["threads", "thread-1", "state"], "state"],
    ["POST", ["threads", "thread-1", "history"], "history"],
    ["POST", ["threads", "thread-1", "runs", "stream"], "run"],
    ["POST", ["threads", "thread-1", "runs", "run-1", "cancel"], "cancel"],
  ] as const)("allow-lists %s %s as %s", (method, parts, expected) => {
    expect(assistantGatewayInternals.endpointFor(parts, method)).toBe(expected);
  });

  it("rejects path traversal and unsupported operations", () => {
    expect(assistantGatewayInternals.endpointFor(["threads", "..", "state"], "GET")).toBeUndefined();
    expect(assistantGatewayInternals.endpointFor(["graphs", "agent"], "GET")).toBeUndefined();
    expect(assistantGatewayInternals.endpointFor(["threads", "thread-1"], "PUT")).toBeUndefined();
    expect(assistantGatewayInternals.endpointFor(["threads", "thread-1", "history"], "GET")).toBeUndefined();
  });

  it("bounds history pagination without forwarding browser-owned filters", () => {
    const body = { limit: 25 };
    const normalized = assistantGatewayInternals.normalizeBody("history", body, scope);

    expect(normalized).toEqual({ limit: 25 });
    expect(normalized).not.toBe(body);
  });

  it("rebuilds SDK history cursors from an opaque checkpoint ID and the authorized path thread", () => {
    expect(assistantGatewayInternals.normalizeBody("history", {
      limit: 25,
      before: { configurable: { checkpoint_id: "cp-page-1" } },
    }, scope, "thread-authorized")).toEqual({
      limit: 25,
      before: {
        configurable: {
          thread_id: "thread-authorized",
          checkpoint_ns: "",
          checkpoint_id: "cp-page-1",
        },
      },
    });
  });

  it("defaults history pages to the SDK's bounded page size", () => {
    expect(assistantGatewayInternals.normalizeBody("history", {}, scope)).toEqual({ limit: 10 });
  });

  it("defaults an omitted history body to the SDK page size", () => {
    expect(assistantGatewayInternals.normalizeBody("history", undefined, scope)).toEqual({ limit: 10 });
  });

  it.each([
    { limit: 0 },
    { limit: null },
    { limit: 101 },
    { limit: 1.5 },
    { user_id: 999 },
    { workspace_id: 999 },
    { assistant_id: "agent" },
    { metadata: { workspace_id: 999 } },
    { before: { configurable: { thread_id: "other-thread" } } },
    { before: { configurable: { checkpoint_id: "cp-1", thread_id: "other-thread" } } },
    { before: { configurable: { checkpoint_id: "cp-1", checkpoint_ns: "other-namespace" } } },
    { before: { configurable: { checkpoint_id: "cp-1", user_id: 999 } } },
    { before: { configurable: { checkpoint_id: "cp-1" }, arbitrary: true } },
    { before: { configurable: { checkpoint_id: "" } } },
    { before: { configurable: { checkpoint_id: "cp-1" } } },
    { checkpoint: { checkpoint_ns: "other-namespace" } },
    { arbitrary: true },
  ])("rejects unsafe history body %j", (body) => {
    expect(() => assistantGatewayInternals.normalizeBody("history", body, scope)).toThrow();
  });

  it("rejects a null history body", () => {
    expect(() => assistantGatewayInternals.normalizeBody("history", null, scope)).toThrow();
  });

  it("derives tenant identity and normalizes the composed text message", () => {
    const normalized = assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      input: {
        messages: [{
          type: "human",
          content: [
            { type: "text", text: "مرحبا بالعالم" },
          ],
          id: "client-id",
        }],
      },
      stream_mode: ["messages", "updates", "custom"],
    }, scope);

    expect(normalized).toMatchObject({
      assistant_id: "agent",
      input: {
        messages: [{ type: "human", content: "مرحبا بالعالم", id: "human:42:client-id" }],
        user_id: 42,
        business_profile_id: 7,
        workspace_id: 11,
        channel: "internal_copilot",
      },
      on_disconnect: "cancel",
      multitask_strategy: "reject",
    });
  });

  it("supports approval resumes without fabricating a new message", () => {
    const normalized = assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      input: null,
      command: { resume: { approved: true } },
    }, scope);

    expect(normalized).toEqual({
      assistant_id: "agent",
      command: { resume: { approved: true } },
      stream_mode: undefined,
      on_disconnect: "cancel",
      multitask_strategy: "reject",
    });
  });

  it.each([
    { approved: true, decision: "later" },
    { approved: "yes", decision: "approved" },
  ])("rejects resume objects with conflicting invalid fields %j", (resume) => {
    expect(() => assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      command: { resume },
    }, scope)).toThrow();
  });

  it("rejects a message whose declared type and role disagree", () => {
    expect(() => assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      input: {
        messages: [{
          type: "human",
          role: "assistant",
          content: "hello",
        }],
      },
    }, scope)).toThrow();
  });

  it("forwards the scalar SDK checkpoint ID for a human-run fork", () => {
    expect(assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      input: { messages: [{ type: "human", content: "edited" }] },
      checkpoint_id: "cp-123",
    }, scope)).toMatchObject({
      checkpoint_id: "cp-123",
    });
  });

  it("regenerates from an authorized thread checkpoint without adding a human message", () => {
    expect(assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent", input: null, checkpoint_id: " cp-human ",
      stream_mode: ["messages", "updates", "custom"],
    }, scope)).toEqual({
      assistant_id: "agent", input: null, checkpoint_id: "cp-human",
      stream_mode: ["messages", "updates", "custom"],
      on_disconnect: "cancel", multitask_strategy: "reject",
    });
  });

  it.each([
    { input: null },
    { input: null, checkpoint_id: " " },
    { input: null, checkpoint_id: 123 },
    { checkpoint_id: "cp-human" },
    { input: { messages: [] }, checkpoint_id: "cp-human" },
    { input: null, checkpoint_id: "cp-human", command: { resume: true } },
  ])("rejects ambiguous checkpoint-only requests %j", (body) => {
    expect(() => assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent", ...body,
    }, scope)).toThrow();
  });

  it.each([
    { checkpoint: { checkpoint_id: "cp-123" } },
    { checkpoint_id: "   " },
    { checkpoint_id: "x".repeat(257) },
    { config: { configurable: { thread_id: "other-thread" } } },
  ])("rejects legacy or client-scoped checkpoint data %j", (extra) => {
    expect(() => assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      input: { messages: [{ type: "human", content: "edited" }] },
      ...extra,
    }, scope)).toThrow();
  });

  it("rejects checkpoint IDs on approval resumes", () => {
    expect(() => assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      command: { resume: { approved: true } },
      checkpoint_id: "cp-123",
    }, scope)).toThrow();
  });

  it("accepts the SDK's optional empty run config without forwarding client state", () => {
    const normalized = assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      input: { messages: [{ type: "human", content: "hello" }] },
      stream_mode: ["messages", "updates", "custom"],
      config: {},
    }, scope);

    expect(normalized).not.toHaveProperty("config");
    expect(normalized).toMatchObject({
      assistant_id: "agent",
      input: { messages: [{ type: "human", content: "hello" }] },
    });
  });

  it("preserves official image_url content for mobile and web attachments", () => {
    const normalized = assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      input: {
        messages: [{
          type: "human",
          content: [
            { type: "text", text: "حلل هذه الصورة" },
            { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA", detail: "low" } },
          ],
        }],
      },
    }, scope);

    expect(normalized?.input).toMatchObject({
      messages: [{
        content: [
          { type: "text", text: "حلل هذه الصورة" },
          { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA", detail: "low" } },
        ],
      }],
    });
  });

  it("rejects unsafe or unsupported attachment content", () => {
    expect(() => assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      input: { messages: [{ type: "human", content: [{ type: "image_url", image_url: "javascript:alert(1)" }] }] },
    }, scope)).toThrowError(/image/i);

    expect(() => assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      input: { messages: [{ type: "human", content: [{ type: "file", data: "secret" }] }] },
    }, scope)).toThrowError(/unsupported/i);
  });

  it("rejects client-controlled graph and unknown fields", () => {
    expect(() => assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "other-graph",
      input: { messages: [] },
    }, scope)).toThrowError(/graph/i);

    expect(() => assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      input: { messages: [] },
      user_id: 999,
    }, scope)).toThrowError(/fields/i);
  });

  it("preserves string titles in create and update normalization", () => {
    expect(assistantGatewayInternals.normalizeBody("create", {
      metadata: { title: "  Existing title  " },
    }, scope)).toMatchObject({
      metadata: { workspace_id: 11, title: "Existing title" },
    });

    expect(assistantGatewayInternals.normalizeBody("update", {
      metadata: { title: "Renamed title" },
    }, scope)).toMatchObject({
      metadata: { workspace_id: 11, title: "Renamed title" },
    });
  });

  it("ignores client tenant metadata and stamps the authorized workspace", () => {
    expect(assistantGatewayInternals.normalizeBody("create", {
      metadata: { title: " Owner chat ", workspace_id: 999 },
    }, scope)).toEqual({
      metadata: { workspace_id: 11, title: "Owner chat" },
      input: {
        user_id: 42,
        business_profile_id: 7,
        workspace_id: 11,
        channel: "internal_copilot",
      },
    });
  });

  it.each([
    { command: { resume: { approved: true } }, checkpoint_id: "cp-1" },
    { command: { resume: { approved: true } }, input: { messages: [{ type: "human", content: "also send" }] } },
  ])("rejects mixed interrupt resume payloads: %j", (payload) => {
    expect(() => assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      ...payload,
    }, scope)).toThrow();
  });

  it("rejects an unauthorized workspace selector before contacting Agent Server", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    workspaceAccess.requireWorkspaceProfileAccess.mockRejectedValueOnce(
      Object.assign(new Error("forbidden"), { statusCode: 403 }),
    );

    await expect(assistantGateway({
      user: { id: 42 },
      path: "threads",
      method: "POST",
      query: {},
      headers: { "x-workspace-id": "999" },
      cookies: {},
      body: {},
    } as never, {} as never)).rejects.toMatchObject({ statusCode: 403 });

    expect(workspaceAccess.getActiveProfileId).toHaveBeenCalledWith(42, undefined, 999);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("derives a deterministic title from the normalized first human message", () => {
    expect(assistantGatewayInternals.automaticTitleFromRun({
      input: {
        messages: [{
          type: "human",
          content: "  Plan   a launch\nfor my store  ",
        }],
      },
    })).toBe("Plan a launch for my store");
  });

  it("does not derive a title from image-only input or resume commands", () => {
    expect(assistantGatewayInternals.automaticTitleFromRun({
      input: { messages: [{ type: "human", content: [{
        type: "image_url", image_url: "data:image/png;base64,AAAA",
      }] }] },
    })).toBeUndefined();
    expect(assistantGatewayInternals.automaticTitleFromRun({
      command: { resume: { approved: true } },
    })).toBeUndefined();
  });

  it("sets a server title from the earliest persisted human message", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ metadata: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ values: {
        messages: [{ type: "human", content: "Earlier server message" }],
      } }), { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    await assistantGatewayInternals.ensureThreadTitle({
      apiUrl: "https://agent.test",
      threadId: "thread-1",
      title: "Current message must not win",
      headers: new Headers({ "x-api-key": "test-key" }),
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(
      3,
      "https://agent.test/threads/thread-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ metadata: { title: "Earlier server message" } }),
      }),
    );
  });

  it("does not overwrite a title already stored on the server", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ metadata: { title: "Manual rename" } }), { status: 200 }),
    );

    await assistantGatewayInternals.ensureThreadTitle({
      apiUrl: "https://agent.test",
      threadId: "thread-1",
      title: "Automatic title",
      headers: new Headers({ "x-api-key": "test-key" }),
      signal: new AbortController().signal,
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not throw when server title persistence fails", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("agent unavailable"));

    await expect(assistantGatewayInternals.ensureThreadTitle({
      apiUrl: "https://agent.test",
      threadId: "thread-1",
      title: "Automatic title",
      headers: new Headers({ "x-api-key": "test-key" }),
      signal: new AbortController().signal,
      fetchImpl,
    })).resolves.toBeUndefined();
  });
});
