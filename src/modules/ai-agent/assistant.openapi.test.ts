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

  const contentFixtures: ReadonlyArray<readonly [string, unknown, boolean]> = [
    ["nonblank text", "hello", true],
    ["trimmed nonblank text", "  hello  ", true],
    ["blank text", "", false],
    ["whitespace-only text", " \t\n ", false],
    ["text part", [{ type: "text", text: "hello" }], true],
    ["text delta part", [{ type: "text_delta", text: "hello" }], true],
    ["whitespace-only text part", [{ type: "text", text: "  " }], false],
    ["HTTP image URL", [{ type: "image_url", image_url: "http://example.com/image.png" }], true],
    ["HTTPS image URL object", [{
      type: "image_url",
      image_url: { url: "https://example.com/image.png", detail: "high" },
    }], true],
    ["image alias with data URL", [{ type: "image", image: "data:image/png;base64,AAAA" }], true],
    ["mixed text and image parts", [
      { type: "text", text: "describe this" },
      { type: "image", image: { url: "HTTPS://example.com/image.png", detail: "auto" } },
    ], true],
    ["unsupported video part", [{ type: "video", url: "https://example.com/video.mp4" }], false],
    ["relative image URL", [{ type: "image_url", image_url: "/image.png" }], false],
    ["FTP image URL", [{ type: "image_url", image_url: "ftp://example.com/image.png" }], false],
    ["non-image data URL", [{ type: "image", image: "data:text/plain;base64,AAAA" }], false],
    ["malformed HTTP image URL", [{ type: "image_url", image_url: "https://" }], false],
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
