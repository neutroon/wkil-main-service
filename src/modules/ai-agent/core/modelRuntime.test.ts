import { describe, expect, it } from "vitest";

import {
  buildDecisionOrToolSystemInstruction,
  buildToolChoiceSystemInstruction,
  getChatModelTiers,
} from "./modelRuntime";

describe("buildToolChoiceSystemInstruction", () => {
  it("makes the tool-selection pass prefer native tool calls over JSON text", () => {
    const prompt = buildToolChoiceSystemInstruction(
      [
        "<rules>",
        "1. Speak strictly in the language and dialect specified in <persona>.",
        "2. Return one structured JSON object only.",
        "</rules>",
        "<output_contract>",
        "Return exactly one JSON object.",
        "</output_contract>",
      ].join("\n"),
    );

    expect(prompt).toContain("suspend the normal JSON output contract");
    expect(prompt).toContain("emit a native tool/function call");
    expect(prompt).toContain("Do not write integration_action_* as text");
    expect(prompt).toContain("combine the current message with recent chat history");
    expect(prompt).toContain("target item/service/course/order");
    expect(prompt).toContain("Do not call a read/list/search helper");
    expect(prompt).toContain("NO_TOOL_CALL");
    expect(prompt).not.toContain("<output_contract>");
    expect(prompt).not.toContain("2. Return one structured JSON object only.");
  });
});

describe("buildDecisionOrToolSystemInstruction", () => {
  it("keeps tool selection semantic without language-specific deterministic rules", () => {
    const prompt = buildDecisionOrToolSystemInstruction(
      [
        "<rules>",
        "1. Speak strictly in the language and dialect specified in <persona>.",
        "2. Return one structured JSON object only.",
        "</rules>",
        "<output_contract>",
        "Return exactly one JSON object.",
        "</output_contract>",
      ].join("\n"),
    );

    expect(prompt).toContain("either emit one native tool/function call");
    expect(prompt).toContain("Use semantic understanding");
    expect(prompt).toContain("Do not rely on keyword matching");
    expect(prompt).toContain("return exactly one JSON object");
    expect(prompt).toContain("<output_contract>");
    expect(prompt).not.toContain("NO_TOOL_CALL");
  });
});

describe("getChatModelTiers", () => {
  it("defaults chat to the low-latency tier before quality fallbacks", () => {
    expect(getChatModelTiers()).toEqual([
      "gemini-3.1-flash-lite-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-flash",
    ]);
  });
});
