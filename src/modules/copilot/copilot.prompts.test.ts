import { describe, expect, it } from "vitest";
import { buildCopilotSystemPrompt } from "./copilot.prompts";

describe("buildCopilotSystemPrompt", () => {
  it("answers in Egyptian Arabic for ar owners", () => {
    const p = buildCopilotSystemPrompt({ mode: "general", locale: "ar", onboardingStep: null });
    expect(p).toContain("Egyptian Arabic");
    expect(p).toContain("copilot");
  });

  it("guides the onboarding interview step by step", () => {
    const p = buildCopilotSystemPrompt({ mode: "onboarding", locale: "en", onboardingStep: "website_scrape" });
    expect(p).toContain("website_scrape");
    expect(p).toContain("scrape_website");
  });
});
