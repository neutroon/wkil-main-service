import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  formatChannelStyleRules,
  getChannelPromptProfile,
} from "./prompt.service";

const baseProfile = {
  name: "pagesPilot",
  identity: "AI content automation platform",
  voice: "Egyptian Arabic",
  tone: "Inspirational",
};
const legacyCustomerDetailsTool = ["save", "customer", "details"].join("_");

describe("buildSystemPrompt", () => {
  it("builds only relevant capability sections for direct chat", () => {
    const prompt = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [{ chunkType: "faq", content: "pagesPilot helps automate content." }],
      channel: "web",
      customerPhone: "+20100111222",
      hasChatRequestedActions: false,
      hasMediaAssets: false,
      hasCompletedActionResult: false,
    });

    expect(prompt).not.toContain("<customer_memory_protocol>");
    expect(prompt).not.toContain(legacyCustomerDetailsTool);
    expect(prompt).not.toContain("<chat_requested_action_protocol>");
    expect(prompt).not.toContain("If sending a file");
    expect(prompt).toContain("<direct_chat_style>");
    expect(prompt).toContain("Write a concise direct-chat reply from the allowed evidence.");
    expect(prompt).not.toContain("Channel: Web chat");
    expect(prompt).not.toContain("Customer-facing field: content");
  });

  it("keeps customer memory out of chat actions and enforces real action parameters", () => {
    const prompt = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [],
      channel: "whatsapp",
      customerPhone: "+20100111222",
      hasChatRequestedActions: true,
    });

    expect(prompt).toContain("<customer_phone>+20100111222</customer_phone>");
    expect(prompt).not.toContain(legacyCustomerDetailsTool);
    expect(prompt).toContain("customer memory saving");
    expect(prompt).toContain(
      "Use only real parameters from the customer, chat history, or <chat_context>.",
    );
    expect(prompt).toContain(
      "If required parameters are missing, ask one concise clarification question instead of calling the action.",
    );
  });

  it("adds chat action rules only when actions are exposed or completed", () => {
    const promptWithAction = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [],
      channel: "messenger",
      hasChatRequestedActions: true,
    });
    const promptWithCompletedResult = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [],
      channel: "messenger",
      hasCompletedActionResult: true,
    });
    const promptWithoutAction = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [],
      channel: "messenger",
    });

    expect(promptWithAction).toContain("<chat_requested_action_protocol>");
    expect(promptWithAction).toContain("Queued action:");
    expect(promptWithCompletedResult).toContain("<chat_requested_action_protocol>");
    expect(promptWithCompletedResult).toContain("Completed action:");
    expect(promptWithoutAction).not.toContain("<chat_requested_action_protocol>");
  });

  it("builds facebook comment prompt with only facebook channel behavior", () => {
    const prompt = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [],
      channel: "facebook_comment",
    });

    expect(prompt).toContain("<facebook_comment_style>");
    expect(prompt).toContain("publicContent is the public comment");
    expect(prompt).toContain("privateContent is the private message");
    expect(prompt).not.toContain("Customer-facing field: publicContent/privateContent");
    expect(prompt).not.toContain("Channel: WhatsApp");
    expect(prompt).not.toContain("Channel: Web chat");
  });

  it("keeps direct-message channel prompts as close as possible", () => {
    const webPrompt = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [],
      channel: "web",
    });
    const whatsappPrompt = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [],
      channel: "whatsapp",
    });
    const messengerPrompt = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [],
      channel: "messenger",
    });

    for (const prompt of [webPrompt, whatsappPrompt, messengerPrompt]) {
      expect(prompt).toContain(
        "Write a concise direct-chat reply from the allowed evidence.",
      );
      expect(prompt).toContain(
        "Ask at most one focused follow-up question when clarification is needed.",
      );
      expect(prompt).not.toContain("web chat, WhatsApp, and Messenger");
      expect(prompt).not.toContain("other direct-message channels");
      expect(prompt).not.toContain("Channel:");
      expect(prompt).not.toContain("Customer-facing field:");
    }

    expect(getChannelPromptProfile("web").replyStyleRules).toEqual(
      getChannelPromptProfile("whatsapp").replyStyleRules,
    );
    expect(getChannelPromptProfile("web").replyStyleRules).toEqual(
      getChannelPromptProfile("messenger").replyStyleRules,
    );
    expect(getChannelPromptProfile("web").statusStyleRules).toEqual(
      getChannelPromptProfile("whatsapp").statusStyleRules,
    );
    expect(getChannelPromptProfile("web").recoveryStyleRules).toEqual(
      getChannelPromptProfile("messenger").recoveryStyleRules,
    );

    expect(webPrompt).toContain("bullets are allowed only when they make the answer easier to scan");
    expect(whatsappPrompt).not.toContain("Channel: Messenger");
    expect(messengerPrompt).not.toContain("Channel: WhatsApp");
  });

  it("does not include risky invented factual examples or old live-lookup wording", () => {
    const prompt = buildSystemPrompt({
      businessProfile: baseProfile,
      context: [],
      channel: "messenger",
      hasChatRequestedActions: true,
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
    expect(prompt.indexOf("<rules>")).toBeLessThan(
      prompt.indexOf("<business_behavior_guidelines>"),
    );
  });
});

describe("channel prompt profiles", () => {
  it("provides reusable style rules for status and recovery prompts", () => {
    expect(getChannelPromptProfile("web").label).toBe("Web chat");
    expect(formatChannelStyleRules("whatsapp", "status")).toContain(
      "compact chat status update",
    );
    expect(formatChannelStyleRules("facebook_comment", "recovery")).toContain(
      "publicContent",
    );
  });
});
