import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks=vi.hoisted(()=>({eval:vi.fn()}));
vi.mock("@config/redis",()=>({redisClient:{eval:mocks.eval}}));
import {acquireOrderSetupPermit} from "./orderConfirmation.setup-rateLimit";
describe("integration setup rate limiting",()=>{
  beforeEach(()=>vi.clearAllMocks());
  it("uses an integration-scoped atomic rolling window with a 30/minute cap",async()=>{
    mocks.eval.mockResolvedValue([1,0]);
    expect(await acquireOrderSetupPermit(7)).toBeNull();
    expect(mocks.eval).toHaveBeenCalledWith(expect.stringContaining("ZREMRANGEBYSCORE"),1,"order-confirmations:setup:7",expect.any(String),"60000","30",expect.any(String));
    mocks.eval.mockResolvedValue([0,1200]);expect(await acquireOrderSetupPermit(8)).toBe(1200);
    expect(mocks.eval.mock.calls[1][2]).toBe("order-confirmations:setup:8");
  });
  it("fails closed when storage fails or returns a malformed result",async()=>{
    mocks.eval.mockRejectedValueOnce(new Error("private redis location"));
    await expect(acquireOrderSetupPermit(7)).rejects.toThrow("Setup rate-limit storage unavailable");
    mocks.eval.mockResolvedValue({});expect(await acquireOrderSetupPermit(7)).toBeGreaterThan(0);
  });
});
