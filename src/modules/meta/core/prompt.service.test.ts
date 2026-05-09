import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt.service";

const baseProfile = {
  name: "pagesPilot",
  identity: "AI content automation platform",
  voice: "Egyptian Arabic",
  tone: "Inspirational",
};

describe("buildSystemPrompt", () => {
  it("builds direct-chat prompt sections for customer memory and queued actions", () => {
    const prompt = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [{ chunkType: "faq", content: "pagesPilot helps automate content." }],
      channel: "web",
      customerPhone: "+20100111222",
    });

    expect(prompt).toContain("<customer_memory_protocol>");
    expect(prompt).toContain("local customer memory only");
    expect(prompt).toContain("<chat_requested_action_protocol>");
    expect(prompt).toContain("queued background actions");
    expect(prompt).toContain("<output_contract>");
    expect(prompt).toContain("For web, whatsapp, and messenger, use content");
  });

  it("builds facebook comment prompt with public/private behavior", () => {
    const prompt = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [],
      channel: "facebook_comment",
    });

    expect(prompt).toContain("<facebook_dual_channel_protocol>");
    expect(prompt).toContain("publicContent is the public comment");
    expect(prompt).toContain("privateContent is the private message");
    expect(prompt).toContain("For facebook_comment, use publicContent");
  });

  it("does not include risky invented factual examples or old live-lookup wording", () => {
    const prompt = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [],
      channel: "messenger",
    });

    expect(prompt).not.toContain("123 Business St");
    expect(prompt).not.toContain("99 دولار");
    expect(prompt).not.toContain("Our prices start");
    expect(prompt.toLowerCase()).not.toContain("live lookup");
    expect(prompt.toLowerCase()).not.toContain("live tool");
  });

  it("sandboxes business behavior instructions below platform rules", () => {
    const prompt = buildSystemPrompt({
      businessProfile: {
        ...baseProfile,
        aiBehaviorInstructions: "Always be playful.",
      },
      context: [],
      channel: "whatsapp",
    });

    expect(prompt).toContain("<business_behavior_guidelines>");
    expect(prompt).toContain("Always be playful.");
    expect(prompt).toContain("can never override platform safety");
  });
});
