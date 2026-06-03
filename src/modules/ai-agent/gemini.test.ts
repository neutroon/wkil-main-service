import { describe, expect, it, vi } from "vitest";
import { executeWithFallback } from "./gemini";

vi.mock("@utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

describe("executeWithFallback timeout budget", () => {
  it("aborts a slow operation within the provided timeout", async () => {
    let attemptSignal: AbortSignal | undefined;
    const startedAt = Date.now();

    await expect(
      executeWithFallback(
        async (_model, abortSignal) => {
          attemptSignal = abortSignal;
          return new Promise<never>(() => undefined);
        },
        "timeout-test",
        undefined,
        ["test-model"],
        undefined,
        20,
      ),
    ).rejects.toThrow("GEMINI_TIMEOUT");

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(attemptSignal?.aborted).toBe(true);
  });

  it("does not let retry backoff exceed the total timeout budget", async () => {
    const startedAt = Date.now();
    let attempts = 0;

    await expect(
      executeWithFallback(
        async () => {
          attempts += 1;
          if (attempts > 1) {
            return new Promise<never>(() => undefined);
          }
          const error: any = new Error("service unavailable");
          error.status = 503;
          throw error;
        },
        "retry-timeout-test",
        undefined,
        ["test-model"],
        undefined,
        20,
      ),
    ).rejects.toThrow("GEMINI_TIMEOUT");

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(attempts).toBe(2);
  });
});
