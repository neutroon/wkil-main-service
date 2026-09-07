import { describe, expect, it } from "vitest";
import { assistantGatewayInternals } from "./assistant.gateway";

const scope = { userId: 42, profileId: 7, workspaceId: 11 };

describe("assistant gateway contract", () => {
  it.each([
    ["POST", ["threads"], "create"],
    ["POST", ["threads", "search"], "search"],
    ["GET", ["threads", "thread-1"], "read"],
    ["PATCH", ["threads", "thread-1"], "update"],
    ["DELETE", ["threads", "thread-1"], "delete"],
    ["GET", ["threads", "thread-1", "state"], "state"],
    ["POST", ["threads", "thread-1", "runs", "stream"], "run"],
    ["POST", ["threads", "thread-1", "runs", "run-1", "cancel"], "cancel"],
  ] as const)("allow-lists %s %s as %s", (method, parts, expected) => {
    expect(assistantGatewayInternals.endpointFor(parts, method)).toBe(expected);
  });

  it("rejects path traversal and unsupported operations", () => {
    expect(assistantGatewayInternals.endpointFor(["threads", "..", "state"], "GET")).toBeUndefined();
    expect(assistantGatewayInternals.endpointFor(["graphs", "agent"], "GET")).toBeUndefined();
    expect(assistantGatewayInternals.endpointFor(["threads", "thread-1"], "PUT")).toBeUndefined();
  });

  it("derives tenant identity and normalizes rich text human messages", () => {
    const normalized = assistantGatewayInternals.normalizeBody("run", {
      assistant_id: "agent",
      input: {
        messages: [{
          type: "human",
          content: [
            { type: "text", text: "مرحبا " },
            { type: "text_delta", text: "بالعالم" },
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
});
