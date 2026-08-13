import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
}));

vi.mock("@config/redis", () => ({
  redisClient: {
    eval: mocks.eval,
  },
}));

import { acquireBusinessSendPermit } from "./orderConfirmation.rateLimit";

describe("order confirmation send permits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows the first 60 sends and returns a retry delay for the 61st", async () => {
    mocks.eval.mockImplementation(async () =>
      mocks.eval.mock.calls.length <= 60 ? [1, 0] : [0, 12_345],
    );

    const permits = [] as Array<number | null>;
    for (let attempt = 0; attempt < 61; attempt += 1) {
      permits.push(await acquireBusinessSendPermit(42));
    }

    expect(permits.slice(0, 60).every((permit) => permit === null)).toBe(true);
    expect(permits[60]).toBe(12_345);
    expect(mocks.eval).toHaveBeenCalledTimes(61);
    expect(mocks.eval.mock.calls[0]?.[1]).toBe(1);
    expect(mocks.eval.mock.calls[0]?.[2]).toBe("order-confirmations:send:42");
  });
});
