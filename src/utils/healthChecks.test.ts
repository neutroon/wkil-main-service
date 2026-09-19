import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.hoisted(() => vi.fn());

vi.stubGlobal("fetch", fetchMock);

vi.mock("@config/prisma", () => ({
  default: { $queryRaw: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@config/redis", () => ({
  redisClient: {
    ping: vi.fn().mockResolvedValue("PONG"),
    status: "ready",
  },
  bullQueuePrefix: "test-prefix",
}));

vi.mock("@utils/logger", () => ({
  logger: { warn: vi.fn() },
}));

vi.mock("@modules/realtime/socket", () => ({
  getRealtimeStats: vi.fn().mockResolvedValue({
    totalConnected: 0,
    perNamespace: {},
    source: "test",
  }),
}));

import { runHealthChecks } from "./healthChecks";

describe("runHealthChecks", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
  });

  it("always includes the Agent Server critical health check", async () => {
    const report = await runHealthChecks();
    const agent = report.checks.find((check) => check.name === "agent");

    expect(agent).toMatchObject({ name: "agent", ok: true, critical: true });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/ok$/));
  });
});
