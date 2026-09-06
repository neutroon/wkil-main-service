import { beforeEach, describe, expect, it, vi } from "vitest";

const agentClient = vi.hoisted(() => ({ runCapability: vi.fn() }));

vi.mock("@modules/ai-agent/client/agent.client", () => ({
  AgentClient: agentClient,
}));

import {
  discoverStrategicLinks,
  extractBusinessIdentity,
} from "./ai.service";

beforeEach(() => vi.clearAllMocks());

describe("website profile AI helpers", () => {
  it("sends the scraped page to strategic-link discovery and returns URL strings", async () => {
    agentClient.runCapability.mockResolvedValue({
      links: [
        {
          url: "https://nile.example/about",
          label: "About us",
          reason: "Explains the business",
        },
      ],
    });

    const links = await discoverStrategicLinks(
      7,
      10,
      "https://nile.example",
      "[About us](/about)",
    );

    expect(agentClient.runCapability).toHaveBeenCalledWith({
      userId: 7,
      businessProfileId: 10,
      operation: "strategic_links",
      context: {
        baseUrl: "https://nile.example",
        pageContent: "[About us](/about)",
      },
    });
    expect(links).toEqual(["https://nile.example/about"]);
  });

  it("sends all website markdown and preserves the camelCase onboarding contract", async () => {
    agentClient.runCapability.mockResolvedValue({
      name: "Nile Coffee",
      identity: "Egyptian specialty coffee",
      target_audience: "Cairo coffee lovers",
      voice: "Warm",
      tone: "Casual",
      products_services: ["Coffee beans", "Brewing gear"],
      core_policies: "Delivery in Cairo within two days",
      confidence: 0.92,
    });

    const identity = await extractBusinessIdentity(
      7,
      10,
      "# Nile Coffee\nFreshly roasted in Cairo.",
    );

    expect(agentClient.runCapability).toHaveBeenCalledWith({
      userId: 7,
      businessProfileId: 10,
      operation: "business_identity",
      context: { markdown: "# Nile Coffee\nFreshly roasted in Cairo." },
    });
    expect(identity).toEqual({
      name: "Nile Coffee",
      identity: "Egyptian specialty coffee",
      targetAudience: "Cairo coffee lovers",
      voice: "Warm",
      tone: "Casual",
      productsServices: ["Coffee beans", "Brewing gear"],
      corePolicies: "Delivery in Cairo within two days",
      confidence: 0.92,
    });
  });
});
