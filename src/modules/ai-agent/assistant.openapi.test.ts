import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { assistantGatewayInternals } from "./assistant.gateway";

type JsonRecord = Record<string, unknown>;

const scope = { userId: 42, profileId: 7, workspaceId: 11 };

function assistantRunSchema(): JsonRecord {
  const document = parse(
    fs.readFileSync(path.resolve(process.cwd(), "docs/openapi.yaml"), "utf8"),
  ) as JsonRecord;
  const paths = document.paths as JsonRecord;
  const operation = (paths["/v1/assistant/threads/{threadId}/runs/stream"] as JsonRecord)
    .post as JsonRecord;
  const requestBody = operation.requestBody as JsonRecord;
  const content = requestBody.content as JsonRecord;
  return {
    ...((content["application/json"] as JsonRecord).schema as JsonRecord),
    components: document.components,
  };
}

describe("assistant run OpenAPI contract", () => {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  const validate = ajv.compile(assistantRunSchema());
  const maxLengthText = "x".repeat(16_000);

  const contentFixtures: ReadonlyArray<readonly [string, unknown, boolean]> = [
    ["nonblank text", "hello", true],
    ["trimmed nonblank text", "  hello  ", true],
    ["maximum-length text", maxLengthText, true],
    ["overlength text with leading whitespace", ` ${maxLengthText}`, false],
    ["blank text", "", false],
    ["whitespace-only text", " \t\n ", false],
    ["text part", [{ type: "text", text: "hello" }], true],
    ["text delta part", [{ type: "text_delta", text: "hello" }], true],
    ["maximum-length text part", [{ type: "text", text: maxLengthText }], true],
    ["overlength text part", [{ type: "text", text: `${maxLengthText}x` }], false],
    ["whitespace-only text part", [{ type: "text", text: "  " }], false],
    ["two text-like parts over the aggregate limit", [
      { type: "text", text: "x".repeat(9_000) },
      { type: "text_delta", text: "x".repeat(9_000) },
    ], false],
    ["two otherwise-valid text-like parts", [
      { type: "text", text: "describe" },
      { type: "text_delta", text: " this" },
    ], false],
    ["HTTP image URL", [{ type: "image_url", image_url: "http://example.com/image.png" }], true],
    ["HTTPS image URL object", [{
      type: "image_url",
      image_url: { url: "https://example.com/image.png", detail: "high" },
    }], true],
    ["IPv6 image URL with encoded path, query, and fragment", [{
      type: "image_url",
      image_url: "https://[2001:db8::1]/image%20file.png?size=large%2Fwide&v=1#preview/1?ready",
    }], true],
    ["image alias with data URL", [{ type: "image", image: "data:image/png;base64,AAAA" }], true],
    ["percent-encoded SVG image data URL", [{
      type: "image",
      image: "data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%3E%3C/svg%3E",
    }], true],
    ["image-only content with assistant-ui blank text sentinel", [
      { type: "text", text: " " },
      { type: "image_url", image_url: { url: "https://example.com/image.png" } },
    ], true],
    ["mixed text and image parts", [
      { type: "text", text: "describe this" },
      { type: "image", image: { url: "HTTPS://example.com/image.png", detail: "auto" } },
    ], true],
    ["numeric text part mixed with image", [
      { type: "text", text: 42 },
      { type: "image_url", image_url: "https://example.com/image.png" },
    ], false],
    ["unsupported video part", [{ type: "video", url: "https://example.com/video.mp4" }], false],
    ["relative image URL", [{ type: "image_url", image_url: "/image.png" }], false],
    ["FTP image URL", [{ type: "image_url", image_url: "ftp://example.com/image.png" }], false],
    ["non-image data URL", [{ type: "image", image: "data:text/plain;base64,AAAA" }], false],
    ["malformed HTTP image URL", [{ type: "image_url", image_url: "https://" }], false],
    ["image URL containing whitespace", [{
      type: "image_url", image_url: "https://example.com/image file.png",
    }], false],
    ["image URL containing a backslash-normalized path", [{
      type: "image_url", image_url: "https://example.com/image\\file.png",
    }], false],
    ["image URL containing an unescaped URI character", [{
      type: "image_url", image_url: "https://example.com/image|file.png",
    }], false],
    ["image URL containing brackets outside an IP literal", [{
      type: "image_url", image_url: "https://example.com/image[1].png",
    }], false],
    ["image URL containing a malformed percent escape", [{
      type: "image_url", image_url: "https://example.com/image%2G.png",
    }], false],
    ["image URL containing a non-ASCII host", [{
      type: "image_url", image_url: "https://例え.テスト/image.png",
    }], false],
    ["invalid image detail", [{
      type: "image_url",
      image_url: { url: "https://example.com/image.png", detail: "original" },
    }], false],
  ];

  it.each(contentFixtures)("keeps OpenAPI and gateway parity for %s", (_label, content, accepted) => {
    const body = {
      assistant_id: "agent",
      input: { messages: [{ type: "human", content }] },
    };

    const schemaAccepted = validate(body);
    let gatewayAccepted = true;
    try {
      assistantGatewayInternals.normalizeBody("run", body, scope);
    } catch {
      gatewayAccepted = false;
    }

    expect(gatewayAccepted).toBe(accepted);
    expect(schemaAccepted, JSON.stringify(validate.errors)).toBe(accepted);
    expect(schemaAccepted).toBe(gatewayAccepted);
  });

  it.each([
    ["array-valued image detail", {
      assistant_id: "agent",
      input: { messages: [{
        type: "human",
        content: [{
          type: "image_url",
          image_url: { url: "https://example.com/image.png", detail: ["high"] },
        }],
      }] },
    }],
    ["array-valued resume decision", {
      assistant_id: "agent",
      command: { resume: { decision: ["approved"] } },
    }],
    ["array-valued message type", {
      assistant_id: "agent",
      input: { messages: [{ type: ["human"], content: "hello" }] },
    }],
    ["nested-array stream mode", {
      assistant_id: "agent",
      input: { messages: [{ type: "human", content: "hello" }] },
      stream_mode: [["messages"]],
    }],
  ])("rejects schema-invalid primitive shape %s at both boundaries", (_label, body) => {
    const schemaAccepted = validate(body);
    let gatewayAccepted = true;
    try {
      assistantGatewayInternals.normalizeBody("run", body, scope);
    } catch {
      gatewayAccepted = false;
    }

    expect(schemaAccepted, JSON.stringify(validate.errors)).toBe(false);
    expect(gatewayAccepted).toBe(false);
    expect(schemaAccepted).toBe(gatewayAccepted);
  });

  it.each([
    ["ordinary human run", {
      assistant_id: "agent",
      input: { messages: [{ type: "human", content: "hello" }] },
      config: {},
    }],
    ["edited human run", {
      assistant_id: "agent",
      input: { messages: [{ type: "human", content: "edited" }] },
      checkpoint_id: "cp-123",
      config: {},
    }],
    ["checkpoint regeneration", {
      assistant_id: "agent",
      input: null,
      checkpoint_id: "cp-123",
      config: {},
    }],
    ["interrupt resume", {
      assistant_id: "agent",
      command: { resume: { approved: true } },
      config: {},
    }],
    ["interrupt resume with SDK null input", {
      assistant_id: "agent",
      input: null,
      command: { resume: "approved" },
      config: {},
    }],
  ])("accepts the %s branch", (_label, body) => {
    expect(validate(body), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["missing execution mode", { assistant_id: "agent" }],
    ["two human messages", {
      assistant_id: "agent",
      input: { messages: [
        { type: "human", content: "one" },
        { type: "human", content: "two" },
      ] },
    }],
    ["non-human message", {
      assistant_id: "agent",
      input: { messages: [{ type: "ai", content: "not allowed" }] },
    }],
    ["human input plus command", {
      assistant_id: "agent",
      input: { messages: [{ type: "human", content: "conflict" }] },
      command: { resume: true },
    }],
    ["regeneration without checkpoint", { assistant_id: "agent", input: null }],
    ["regeneration plus command", {
      assistant_id: "agent",
      input: null,
      checkpoint_id: "cp-123",
      command: { resume: true },
    }],
    ["resume plus checkpoint", {
      assistant_id: "agent",
      checkpoint_id: "cp-123",
      command: { resume: true },
    }],
    ["resume plus non-null input", {
      assistant_id: "agent",
      input: { messages: [{ type: "human", content: "conflict" }] },
      command: { resume: true },
    }],
    ["non-empty client config", {
      assistant_id: "agent",
      input: { messages: [{ type: "human", content: "hello" }] },
      config: { configurable: { thread_id: "other" } },
    }],
    ["blank checkpoint", {
      assistant_id: "agent",
      input: null,
      checkpoint_id: "   ",
    }],
  ])("rejects %s", (_label, body) => {
    expect(validate(body)).toBe(false);
  });
});
