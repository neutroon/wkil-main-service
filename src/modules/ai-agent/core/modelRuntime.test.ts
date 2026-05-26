import { describe, expect, it } from "vitest";

import { buildToolChoiceSystemInstruction } from "./modelRuntime";

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
