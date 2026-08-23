import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@config/prisma", () => ({
  default: { businessProfile: { findFirst: vi.fn(), create: vi.fn() } },
}));
vi.mock("@modules/business/profile/businessAccess.service", () => ({
  updateBusinessProfileForOwner: vi.fn(async () => ({ id: 9 })),
}));
vi.mock("@modules/scraping/scraping.service", () => ({
  analyzeWebsiteForUser: vi.fn(async () => ({ identity: "..." })),
}));
vi.mock("../copilot.store", () => ({
  completeCopilotOnboarding: vi.fn(),
  setCopilotOnboardingStep: vi.fn(),
}));

import { updateBusinessProfileForOwner } from "@modules/business/profile/businessAccess.service";
import { analyzeWebsiteForUser } from "@modules/scraping/scraping.service";
import { completeCopilotOnboarding, setCopilotOnboardingStep } from "../copilot.store";
import { findCopilotTool, type CopilotToolContext } from "./index";

const ctx: CopilotToolContext = { userId: 5, conversationId: 7, locale: "ar" };

describe("onboarding tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it("save_business_info resolves the owner's profile and updates it", async () => {
    const prisma = (await import("@config/prisma")).default as any;
    prisma.businessProfile.findFirst.mockResolvedValueOnce({ id: 9 });
    await findCopilotTool("save_business_info")!.handler(
      { name: "Cairo Sweets", tone: "friendly" },
      ctx,
    );
    expect(updateBusinessProfileForOwner).toHaveBeenCalledWith(5, 9, {
      name: "Cairo Sweets",
      tone: "friendly",
    });
    expect(setCopilotOnboardingStep).toHaveBeenCalledWith(7, "website_scrape");
  });

  it("scrape_website reports progress and delegates to the scraping service", async () => {
    const onProgress = vi.fn();
    await findCopilotTool("scrape_website")!.handler(
      { url: "https://shop.example.com" },
      { ...ctx, onProgress },
    );
    expect(analyzeWebsiteForUser).toHaveBeenCalledWith(5, "https://shop.example.com");
    expect(onProgress).toHaveBeenCalled();
    expect(setCopilotOnboardingStep).toHaveBeenCalledWith(7, "kb_review");
  });

  it("finish_onboarding flips the conversation to GENERAL", async () => {
    await findCopilotTool("finish_onboarding")!.handler({}, ctx);
    expect(completeCopilotOnboarding).toHaveBeenCalledWith(7);
  });
});
