import { describe, expect, it } from "vitest";
import { historyToLlmTurns, toPromptMessages } from "./conversationTurns";
import {
  classifyInboundMessageSignal,
  customerMessageForModel,
  isEmojiOnlyText,
} from "./messageSignals";

describe("message signal handling", () => {
  it("keeps emoji-only text as low-signal model context", () => {
    expect(isEmojiOnlyText("👍")).toBe(true);
    expect(customerMessageForModel({ messageText: "👍" })).toBe(
      "[Customer sent emoji-only text: 👍]",
    );
  });

  it("saves passive stickers without triggering the AI", () => {
    expect(
      classifyInboundMessageSignal({
        type: "sticker",
        mediaId: "123",
        mediaMetadata: { stickerId: "123", isSticker: true },
      }),
    ).toEqual({ shouldTriggerAi: false, reason: "passive_sticker" });
  });
});

describe("conversation turn formatting", () => {
  it("represents media turns with metadata and analysis for prompt history", () => {
    const messages = toPromptMessages([
      {
        role: "user",
        content: "",
        type: "image",
        mediaId: "wamid.1",
        mediaMetadata: {
          mimeType: "image/jpeg",
          filename: "receipt.jpg",
          analysis: {
            status: "completed",
            text: "The image appears to show a payment receipt.",
          },
        },
      },
    ]);

    expect(messages[0]).toMatchObject({ role: "user" });
    expect(messages[0].content).toContain("Customer sent image attachment");
    expect(messages[0].content).toContain("receipt.jpg");
    expect(messages[0].content).toContain("payment receipt");
  });

  it("does not describe plain text rows with empty metadata as attachments", () => {
    const messages = toPromptMessages([
      {
        role: "user",
        content: "علم النفس",
        type: "text",
        mediaId: null,
        mediaMetadata: {},
      },
    ]);

    expect(messages[0].content).toBe("علم النفس");
  });

  it("excludes the latest user turn after media-aware formatting", () => {
    const formatted = toPromptMessages([
      { role: "user", content: "hello" },
      {
        role: "user",
        content: "caption",
        type: "image",
        mediaId: "mid.1",
        mediaMetadata: { mimeType: "image/png" },
      },
    ]);

    const history = historyToLlmTurns(formatted);
    expect(history).toEqual([{ role: "user", text: "hello" }]);
  });
});
