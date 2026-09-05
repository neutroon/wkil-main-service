import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.hoisted(() => vi.fn());
vi.mock("@config/prisma", () => ({
  default: { integrationActionRun: { create, update: vi.fn() } },
}));
vi.mock("@utils/logger", () => ({ logger: { warn: vi.fn() } }));

import { createIntegrationActionRun } from "./integrationActionRun.service";

describe("createIntegrationActionRun", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists the complete action envelope as a queued domain run", async () => {
    create.mockResolvedValue({ id: 81, status: "QUEUED" });
    const result = await createIntegrationActionRun({
      businessProfileId: 10,
      sourceId: 22,
      conversationId: 45,
      customerId: 9,
      trigger: "CHAT_REQUESTED",
      actionType: "LOOKUP",
      toolName: "lookup_course",
      jobId: "action-45-22",
      requestPayload: { course: "Data Science" },
    });
    expect(create).toHaveBeenCalledWith({
      data: {
        businessProfileId: 10, sourceId: 22, conversationId: 45,
        customerId: 9, agentTurnId: null, parentRunId: null,
        workflowId: null, stepKey: null, trigger: "CHAT_REQUESTED",
        actionType: "LOOKUP", toolName: "lookup_course",
        jobId: "action-45-22", requestPayload: { course: "Data Science" },
        status: "QUEUED",
      },
    });
    expect(result).toEqual({ id: 81, status: "QUEUED" });
  });
});
