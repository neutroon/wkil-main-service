import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@utils/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("@modules/analytics/dashboard/dashboard.service", () => ({ getUnifiedDashboardStats: vi.fn(async () => ({ totalMessages: 10 })) }));
vi.mock("@modules/business/customer/customer.service", () => ({
  listCustomers: vi.fn(async () => ({ customers: [], total: 0 })),
  getCustomerForUser: vi.fn(async () => { throw new Error("Customer not found"); }),
}));
vi.mock("@modules/analytics/ai/analytics.service", () => ({ getAiPerformanceStats: vi.fn(async () => ({ totalTokens: 5 })) }));

import { listCustomers } from "@modules/business/customer/customer.service";
import { copilotTools, findCopilotTool, type CopilotToolContext } from "./index";

const ctx: CopilotToolContext = { userId: 5, conversationId: 7, locale: "ar" }; // onProgress optional; omitted here

describe("copilot tool registry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("every tool has name, description, zod schema and confirmation flag", () => {
    for (const tool of copilotTools) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(10);
      expect(tool.schema).toBeDefined();
      expect(typeof tool.requiresConfirmation).toBe("boolean");
      expect(typeof tool.handler).toBe("function");
    }
  });

  it("get_conversations_needing_attention queries handoff customers", async () => {
    await findCopilotTool("get_conversations_needing_attention")!.handler({ limit: 5 }, ctx);
    expect(listCustomers).toHaveBeenCalledWith(expect.objectContaining({ userId: 5, status: "handoff" }));
  });

  it("tool handlers surface service errors instead of swallowing them", async () => {
    await expect(findCopilotTool("get_customer")!.handler({ customerId: 1 }, ctx)).rejects.toThrow("Customer not found");
  });
});
