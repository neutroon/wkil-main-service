import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@utils/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Each test gets a fresh mock so the "subscriber started" flag inside the
// module is the only state we need to reset by re-importing.
const mockSubscriber: {
  on: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
} = {
  on: vi.fn(),
  subscribe: vi.fn(async () => undefined),
  quit: vi.fn(async () => undefined),
};

const mockCommandClient = {
  publish: vi.fn(async () => 1),
  duplicate: vi.fn(() => mockSubscriber),
};

vi.mock("@config/redis", () => ({
  redisClient: mockCommandClient,
}));

// Local-only cache clear functions — we want to verify the bus invokes the
// local-only variant and NOT the publishing variant (which would loop).
const clearAiModelCacheLocal = vi.fn();
const clearAiModelCache = vi.fn();
const clearPipelineCacheLocal = vi.fn();
const clearSettingsCacheLocal = vi.fn();
const clearModelPriceCacheLocal = vi.fn();

vi.mock("@modules/admin/ai-model/ai-model.service", () => ({
  clearAiModelCacheLocal,
  clearAiModelCache,
}));
vi.mock("@modules/admin/ai-pipeline/ai-pipeline.service", () => ({
  clearPipelineCacheLocal,
}));
vi.mock("@modules/settings/settings.service", () => ({
  clearSettingsCacheLocal,
}));
vi.mock("@modules/billing/billing.service", () => ({
  clearModelPriceCacheLocal,
}));

describe("cache-bus.publishCacheInvalidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes the key on the configured channel", async () => {
    const bus = await import("./cache-bus");
    await bus.publishCacheInvalidation("ai_models");
    expect(mockCommandClient.publish).toHaveBeenCalledWith(
      "cache:invalidate",
      "ai_models",
    );
  });

  it("does not throw when Redis publish fails", async () => {
    mockCommandClient.publish.mockRejectedValueOnce(new Error("redis down"));
    const bus = await import("./cache-bus");
    await expect(bus.publishCacheInvalidation("settings")).resolves.toBeUndefined();
  });
});

describe("cache-bus.startCacheBusSubscriber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set the default behavior on each test
    mockSubscriber.on.mockReturnValue(mockSubscriber);
    mockSubscriber.subscribe.mockResolvedValue(undefined);
  });

  it("creates a dedicated subscriber via redisClient.duplicate()", async () => {
    // Each test imports the bus fresh because of the once-only `subscriberStarted` flag.
    vi.resetModules();
    const bus = await import("./cache-bus");
    await bus.startCacheBusSubscriber();
    expect(mockCommandClient.duplicate).toHaveBeenCalledTimes(1);
    expect(mockSubscriber.subscribe).toHaveBeenCalledWith("cache:invalidate");
  });

  it("routes 'ai_models' messages to clearAiModelCacheLocal (no publish)", async () => {
    vi.resetModules();
    const bus = await import("./cache-bus");
    await bus.startCacheBusSubscriber();

    // Pull the message handler that was registered on the subscriber.
    const onCalls: any[][] = (mockSubscriber.on.mock.calls as any[][]).filter(
      (call) => call[0] === "message",
    );
    expect(onCalls).toHaveLength(1);
    const handler = onCalls[0]![1] as (ch: string, msg: string) => Promise<void>;

    await handler("cache:invalidate", "ai_models");
    expect(clearAiModelCacheLocal).toHaveBeenCalledTimes(1);
    // CRITICAL: must NOT call the publishing variant — that would loop.
    expect(clearAiModelCache).not.toHaveBeenCalled();
  });

  it("routes 'ai_pipelines' to clearPipelineCacheLocal", async () => {
    vi.resetModules();
    const bus = await import("./cache-bus");
    await bus.startCacheBusSubscriber();
    const onCalls: any[][] = (mockSubscriber.on.mock.calls as any[][]).filter(
      (call) => call[0] === "message",
    );
    const handler = onCalls[0]![1] as (ch: string, msg: string) => Promise<void>;

    await handler("cache:invalidate", "ai_pipelines");
    expect(clearPipelineCacheLocal).toHaveBeenCalledTimes(1);
  });

  it("routes 'settings' to clearSettingsCacheLocal", async () => {
    vi.resetModules();
    const bus = await import("./cache-bus");
    await bus.startCacheBusSubscriber();
    const onCalls: any[][] = (mockSubscriber.on.mock.calls as any[][]).filter(
      (call) => call[0] === "message",
    );
    const handler = onCalls[0]![1] as (ch: string, msg: string) => Promise<void>;

    await handler("cache:invalidate", "settings");
    expect(clearSettingsCacheLocal).toHaveBeenCalledTimes(1);
  });

  it("routes 'model_prices' to clearModelPriceCacheLocal", async () => {
    vi.resetModules();
    const bus = await import("./cache-bus");
    await bus.startCacheBusSubscriber();
    const onCalls: any[][] = (mockSubscriber.on.mock.calls as any[][]).filter(
      (call) => call[0] === "message",
    );
    const handler = onCalls[0]![1] as (ch: string, msg: string) => Promise<void>;

    await handler("cache:invalidate", "model_prices");
    expect(clearModelPriceCacheLocal).toHaveBeenCalledTimes(1);
  });

  it("ignores unknown keys without throwing", async () => {
    vi.resetModules();
    const bus = await import("./cache-bus");
    await bus.startCacheBusSubscriber();
    const onCalls: any[][] = (mockSubscriber.on.mock.calls as any[][]).filter(
      (call) => call[0] === "message",
    );
    const handler = onCalls[0]![1] as (ch: string, msg: string) => Promise<void>;

    await expect(
      handler("cache:invalidate", "nonsense"),
    ).resolves.toBeUndefined();
    expect(clearAiModelCacheLocal).not.toHaveBeenCalled();
    expect(clearPipelineCacheLocal).not.toHaveBeenCalled();
    expect(clearSettingsCacheLocal).not.toHaveBeenCalled();
    expect(clearModelPriceCacheLocal).not.toHaveBeenCalled();
  });

  it("is idempotent: a second call does not create a second subscriber", async () => {
    vi.resetModules();
    const bus = await import("./cache-bus");
    await bus.startCacheBusSubscriber();
    await bus.startCacheBusSubscriber();
    expect(mockCommandClient.duplicate).toHaveBeenCalledTimes(1);
  });

  it("survives a subscriber error (logs warn, does not throw)", async () => {
    vi.resetModules();
    mockSubscriber.on.mockImplementation(
      (event: string, cb: (err?: Error) => void) => {
        if (event === "error") cb(new Error("connection reset"));
      },
    );
    const bus = await import("./cache-bus");
    await expect(bus.startCacheBusSubscriber()).resolves.toBeUndefined();
  });

  it("is a no-op when Redis is unreachable on the first call", async () => {
    vi.resetModules();
    mockSubscriber.subscribe.mockRejectedValueOnce(
      new Error("redis unreachable"),
    );
    const bus = await import("./cache-bus");
    await expect(bus.startCacheBusSubscriber()).resolves.toBeUndefined();
  });
});

describe("cache-bus.stopCacheBusSubscriber", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("quits the subscriber connection cleanly", async () => {
    vi.resetModules();
    const bus = await import("./cache-bus");
    await bus.startCacheBusSubscriber();
    await bus.stopCacheBusSubscriber();
    expect(mockSubscriber.quit).toHaveBeenCalledTimes(1);
  });

  it("is a safe no-op when the subscriber never started", async () => {
    vi.resetModules();
    const bus = await import("./cache-bus");
    await expect(bus.stopCacheBusSubscriber()).resolves.toBeUndefined();
    expect(mockSubscriber.quit).not.toHaveBeenCalled();
  });

  it("tolerates a failing quit() (e.g. socket already closed)", async () => {
    vi.resetModules();
    mockSubscriber.quit.mockRejectedValueOnce(new Error("socket closed"));
    const bus = await import("./cache-bus");
    await bus.startCacheBusSubscriber();
    await expect(bus.stopCacheBusSubscriber()).resolves.toBeUndefined();
  });

  it("allows a fresh start after stop", async () => {
    vi.resetModules();
    const bus = await import("./cache-bus");
    await bus.startCacheBusSubscriber();
    await bus.stopCacheBusSubscriber();
    await bus.startCacheBusSubscriber();
    expect(mockCommandClient.duplicate).toHaveBeenCalledTimes(2);
  });
});
