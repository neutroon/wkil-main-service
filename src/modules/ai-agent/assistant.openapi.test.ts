import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type JsonRecord = Record<string, unknown>;

function assistantRunSchema(): JsonRecord {
  const document = parse(
    fs.readFileSync(path.resolve(process.cwd(), "docs/openapi.yaml"), "utf8"),
  ) as JsonRecord;
  const paths = document.paths as JsonRecord;
  const operation = (paths["/v1/assistant/threads/{threadId}/runs/stream"] as JsonRecord)
    .post as JsonRecord;
  const requestBody = operation.requestBody as JsonRecord;
  const content = requestBody.content as JsonRecord;
  return (content["application/json"] as JsonRecord).schema as JsonRecord;
}

describe("assistant run OpenAPI contract", () => {
  const validate = new Ajv2020({ strict: false }).compile(assistantRunSchema());

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
