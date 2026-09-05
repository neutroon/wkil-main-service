import { beforeEach, describe, expect, it, vi } from "vitest";

const agentClient = vi.hoisted(() => ({ runCapability: vi.fn() }));

vi.mock("@modules/ai-agent/client/agent.client", () => ({
  AgentClient: agentClient,
}));

import { generatePostContent } from "./content.service";

beforeEach(() => vi.clearAllMocks());

describe("generatePostContent", () => {
  it("passes the authenticated tenant and complete post brief to the content capability", async () => {
    agentClient.runCapability.mockResolvedValue({
      caption: "Fresh Cairo-roasted coffee, delivered to your door.",
      hashtags: ["#CairoCoffee", "#FreshRoast"],
      suggested_image: "A coffee bag beside a Cairo window",
      image_prompt: "Warm morning light on a Nile Coffee bag",
      reel_script: null,
      carousel_slides: null,
    });

    const generated = await generatePostContent({
      userId: 7,
      businessProfileId: 10,
      topic: "Fresh roast delivery",
      length: "short",
      keywords: ["Cairo", "coffee"],
      context: "Mention delivery within two days",
      generateImage: true,
      businessProfile: {
        name: "Nile Coffee",
        voice: "Warm",
        tone: "Casual",
        corePolicies: "Never promise same-day delivery",
        aiBehaviorInstructions: "Use Egyptian Arabic when natural",
      },
    });

    expect(agentClient.runCapability).toHaveBeenCalledWith({
      userId: 7,
      businessProfileId: 10,
      operation: "content_post",
      context: {
        topic: "Fresh roast delivery",
        length: "short",
        keywords: ["Cairo", "coffee"],
        additionalContext: "Mention delivery within two days",
        business: {
          name: "Nile Coffee",
          voice: "Warm",
          tone: "Casual",
          corePolicies: "Never promise same-day delivery",
          aiBehaviorInstructions: "Use Egyptian Arabic when natural",
        },
        post: { generateImage: true },
      },
    });
    expect(generated).toEqual({
      content: "Fresh Cairo-roasted coffee, delivered to your door.",
      hashtags: ["#CairoCoffee", "#FreshRoast"],
      suggestedImage: "A coffee bag beside a Cairo window",
    });
  });
});
