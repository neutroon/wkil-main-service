// src/modules/copilot/copilot.store.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => ({
  default: {
    copilotConversation: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    copilotMessage: { create: vi.fn(), findMany: vi.fn() },
  },
}));
vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import prisma from "@config/prisma";
import { AppError } from "@middlewares/errorHandler.middleware";
import {
  appendCopilotMessage,
  completeCopilotOnboarding,
  getCopilotConversationForUser,
  getOrCreateCopilotConversation,
  listCopilotMessages,
  setCopilotOnboardingStep,
} from "./copilot.store";

const mockedPrisma = prisma as unknown as {
  copilotConversation: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  copilotMessage: { create: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
};

describe("copilot.store", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reuses an existing conversation for the user", async () => {
    mockedPrisma.copilotConversation.findFirst.mockResolvedValueOnce({ id: 7, userId: 5, kind: "GENERAL" });
    const conv = await getOrCreateCopilotConversation(5, "ar");
    expect(conv.id).toBe(7);
    expect(mockedPrisma.copilotConversation.create).not.toHaveBeenCalled();
  });

  it("creates an ONBOARDING conversation when none exists", async () => {
    mockedPrisma.copilotConversation.findFirst.mockResolvedValueOnce(null);
    mockedPrisma.copilotConversation.create.mockResolvedValueOnce({ id: 8, userId: 5, kind: "ONBOARDING" });
    const conv = await getOrCreateCopilotConversation(5, "ar");
    expect(mockedPrisma.copilotConversation.create).toHaveBeenCalledWith({ data: { userId: 5, locale: "ar" } });
    expect(conv.kind).toBe("ONBOARDING");
  });

  it("getCopilotConversationForUser throws 404 when not owned", async () => {
    mockedPrisma.copilotConversation.findFirst.mockResolvedValueOnce(null);
    await expect(getCopilotConversationForUser(7, 5)).rejects.toBeInstanceOf(AppError);
  });

  it("appendCopilotMessage bumps lastMessageAt", async () => {
    mockedPrisma.copilotMessage.create.mockResolvedValueOnce({ id: 1 });
    await appendCopilotMessage({ conversationId: 7, role: "USER", envelope: { type: "text", text: "hi" } });
    expect(mockedPrisma.copilotConversation.update).toHaveBeenCalledWith({
      where: { id: 7 }, data: { lastMessageAt: expect.any(Date) },
    });
  });

  it("listCopilotMessages returns chronological order with limit", async () => {
    mockedPrisma.copilotMessage.findMany.mockResolvedValueOnce([{ id: 2 }, { id: 1 }]);
    await listCopilotMessages(7, 20);
    expect(mockedPrisma.copilotMessage.findMany).toHaveBeenCalledWith({
      where: { conversationId: 7 }, orderBy: { createdAt: "desc" }, take: 20,
    });
  });

  it("setCopilotOnboardingStep updates step", async () => {
    await setCopilotOnboardingStep(7, "website_scrape");
    expect(mockedPrisma.copilotConversation.update).toHaveBeenCalledWith({
      where: { id: 7 }, data: { onboardingStep: "website_scrape" },
    });
  });

  it("completeCopilotOnboarding flips kind to GENERAL", async () => {
    await completeCopilotOnboarding(7);
    expect(mockedPrisma.copilotConversation.update).toHaveBeenCalledWith({
      where: { id: 7 }, data: { kind: "GENERAL", onboardingStep: "done" },
    });
  });
});
