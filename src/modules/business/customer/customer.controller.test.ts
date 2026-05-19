import { describe, expect, it, vi } from "vitest";
import { listCustomersController } from "./customer.controller";
import { listCustomers } from "./customer.service";

vi.mock("./customer.service", () => ({
  getCustomerForUser: vi.fn(),
  listCustomerConversations: vi.fn(),
  listCustomers: vi.fn(),
  updateCustomerForUser: vi.fn(),
}));

describe("customer controller", () => {
  it("passes a validated boolean hasPhone query to the service", async () => {
    vi.mocked(listCustomers).mockResolvedValue({
      data: [],
      meta: { total: 0, page: 1, limit: 50, totalPages: 0 },
    });

    const req = {
      user: { id: 5 },
      query: {
        hasPhone: true,
        limit: 50,
      },
    };
    const res = {
      json: vi.fn(),
    };

    await listCustomersController(req as any, res as any);

    expect(listCustomers).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 5,
        hasPhone: true,
        limit: 50,
      }),
    );
    expect(res.json).toHaveBeenCalled();
  });
});
