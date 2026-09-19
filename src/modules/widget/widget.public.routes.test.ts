/**
 * Public widget chat — HTTP tests with mocked Prisma + chat service.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import express, { Application } from "express";
import type { WidgetInstall } from "@prisma/client";

const agentClientMock = vi.hoisted(() => ({
  joinCustomerRun: vi.fn(),
  joinCustomerRunStream: vi.fn(),
  cancelCustomerRun: vi.fn(),
}));

vi.mock("@config/prisma", () => ({
  default: {
    widgetInstall: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("./services/widgetChat.service", () => ({
  processWidgetChatMessage: vi.fn(),
  prepareWidgetChatMessage: vi.fn(),
  completeWidgetChatMessage: vi.fn(),
  failWidgetChatMessage: vi.fn(),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@modules/ai-agent/client/agent.client", () => ({
  AgentClient: agentClientMock,
}));

import widgetPublicRoutes from "./widget.public.routes";
import prisma from "@config/prisma";
import {
  prepareWidgetChatMessage,
  processWidgetChatMessage,
} from "@modules/widget/services/widgetChat.service";
import { logger } from "@utils/logger";

function makeApp(): Application {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use(widgetPublicRoutes);
  return app;
}

function doRequest(
  server: http.Server,
  opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = opts.body ? Buffer.from(opts.body, "utf8") : Buffer.alloc(0);

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: opts.path,
        method: opts.method,
        headers: {
          "content-type": "application/json",
          "content-length": String(payload.length),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload.length) req.write(payload);
    req.end();
  });
}

function abortAfterFirstSseData(
  server: http.Server,
  body: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const req = http.request({
      hostname: "127.0.0.1",
      port: addr.port,
      path: "/chat",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
        "x-widget-site-key": "wsk_test_xxxxxxxx",
        origin: "https://shop.example",
      },
    });
    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    req.on("close", () => resolve());
    req.on("response", (res) => {
      res.once("data", () => req.destroy());
    });
    req.end(body);
  });
}

const baseInstall: WidgetInstall = {
  id: 1,
  userId: 10,
  businessProfileId: 20,
  publicSiteKey: "wsk_test_xxxxxxxx",
  identitySecret: "aabbccdd11223344aabbccdd11223344aabbccdd11223344aabbccdd11223344",
  allowedOrigins: ["https://shop.example"],
  isActive: true,
  settings: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("POST /chat (public widget)", () => {
  let server: http.Server;
  let prevNodeEnv: string | undefined;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        vi.clearAllMocks();
        agentClientMock.cancelCustomerRun.mockResolvedValue(undefined);
        prevNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        server = http.createServer(makeApp()).listen(0, "127.0.0.1", resolve);
      }),
  );

  afterEach(
    () =>
      new Promise<void>((resolve, reject) => {
        process.env.NODE_ENV = prevNodeEnv;
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  );

  it("returns 400 when site key is missing", async () => {
    const res = await doRequest(server, {
      method: "POST",
      path: "/chat",
      headers: {
        origin: "https://shop.example",
      },
      body: JSON.stringify({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Hi",
      }),
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/site key/i);
    expect(prisma.widgetInstall.findFirst).not.toHaveBeenCalled();
  });

  it("returns 403 for invalid or inactive site key", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue(null);

    const res = await doRequest(server, {
      method: "POST",
      path: "/chat",
      headers: {
        "x-widget-site-key": "unknown_key",
        origin: "https://shop.example",
      },
      body: JSON.stringify({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Hi",
      }),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/invalid|inactive/i);
  });

  it("returns 403 when Origin is missing in production", async () => {
    const res = await doRequest(server, {
      method: "POST",
      path: "/chat",
      headers: {
        "x-widget-site-key": "wsk_test_xxxxxxxx",
      },
      body: JSON.stringify({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Hi",
      }),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/origin/i);
    expect(prisma.widgetInstall.findFirst).not.toHaveBeenCalled();
  });

  it("returns 403 when Origin is not in allowlist", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://other.example"],
    });

    const res = await doRequest(server, {
      method: "POST",
      path: "/chat",
      headers: {
        "x-widget-site-key": "wsk_test_xxxxxxxx",
        origin: "https://shop.example",
      },
      body: JSON.stringify({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Hi",
      }),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toMatch(/origin not allowed/i);
  });

  it("returns reply and conversationId on success (mocked AI path)", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    vi.mocked(processWidgetChatMessage).mockResolvedValue({
      reply: "Hello from widget",
      conversationId: 99,
      action: "REPLY",
      attachment: null,
    });

    const res = await doRequest(server, {
      method: "POST",
      path: "/chat",
      headers: {
        "x-widget-site-key": "wsk_test_xxxxxxxx",
        origin: "https://shop.example",
      },
      body: JSON.stringify({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Hi there",
      }),
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      reply: "Hello from widget",
      conversationId: 99,
      action: "REPLY",
      attachment: null,
    });
    expect(processWidgetChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Hi there",
        install: expect.objectContaining({ id: 1 }),
      }),
    );
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://shop.example",
    );
  });

  it("keeps final-only SSE compatibility when stream is requested", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    vi.mocked(prepareWidgetChatMessage).mockResolvedValue({
      result: {
        reply: "Hello from SSE widget",
        conversationId: 101,
        action: "REPLY",
        attachment: null,
      },
    });

    const res = await doRequest(server, {
      method: "POST",
      path: "/chat",
      headers: {
        "x-widget-site-key": "wsk_test_xxxxxxxx",
        origin: "https://shop.example",
      },
      body: JSON.stringify({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Hi there",
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    expect(res.headers["cache-control"]).toContain("no-transform");
    expect(res.headers["x-accel-buffering"]).toBe("no");
    expect(res.body).toContain("data: ");
    expect(res.body).toContain("\"reply\":\"Hello from SSE widget\"");
    expect(res.body).toContain("\"conversationId\":101");
    expect(res.body).toContain("\"action\":\"REPLY\"");
    expect(res.body).toContain("data: [DONE]");
  });

  it("consumes the exact run stream to exhaustion and joins its final state", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    vi.mocked(prepareWidgetChatMessage).mockResolvedValue({
      handle: { agentTurnId: 8, threadId: "thread-1", runId: "run-1" },
      turnParams: {},
      businessProfileId: 20,
      conversationId: 101,
    } as any);
    let streamExhausted = false;
    agentClientMock.joinCustomerRunStream.mockReturnValue((async function* () {
      yield {
        event: "values",
        data: {
          structured_response: {
            action: "REPLY",
            content: "Intermediate response",
            reason_code: "KNOWLEDGE_MATCH",
            handoff_category: null,
          },
        },
      };
      yield { event: "metadata", data: { run_id: "run-1", phase: "complete" } };
      streamExhausted = true;
    })());
    const finalDecision = {
      action: "HANDOFF",
      content: null,
      reason_code: "HUMAN_ACTION_REQUIRED",
      handoff_category: "SUPPORT",
    };
    agentClientMock.joinCustomerRun.mockResolvedValue(finalDecision);
    vi.mocked((await import("./services/widgetChat.service")).completeWidgetChatMessage)
      .mockResolvedValue({ reply: "", action: "HANDOFF", conversationId: 101, attachment: null });

    const res = await doRequest(server, {
      method: "POST",
      path: "/chat",
      headers: {
        "x-widget-site-key": "wsk_test_xxxxxxxx",
        origin: "https://shop.example",
      },
      body: JSON.stringify({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Please help",
        stream: true,
      }),
    });

    expect(agentClientMock.joinCustomerRunStream).toHaveBeenCalledWith(
      "thread-1",
      "run-1",
      expect.objectContaining({ cancelOnDisconnect: true, signal: expect.any(AbortSignal) }),
    );
    expect(res.body).toContain("\"event\":\"values\"");
    expect(res.body).toContain("\"action\":\"HANDOFF\"");
    expect(streamExhausted).toBe(true);
    expect(agentClientMock.joinCustomerRun).toHaveBeenCalledWith(
      "thread-1",
      "run-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect((await import("./services/widgetChat.service")).completeWidgetChatMessage)
      .toHaveBeenCalledWith(expect.anything(), finalDecision);
    expect(agentClientMock.cancelCustomerRun).not.toHaveBeenCalled();
  });

  it("reads the exact run final state when an unbuffered join stream has already ended", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    vi.mocked(prepareWidgetChatMessage).mockResolvedValue({
      handle: { agentTurnId: 8, threadId: "thread-fast", runId: "run-fast" },
      turnParams: {},
      businessProfileId: 20,
      conversationId: 101,
    } as any);
    agentClientMock.joinCustomerRunStream.mockReturnValue((async function* () {
      yield { event: "metadata", data: { run_id: "run-fast" } };
    })());
    agentClientMock.joinCustomerRun.mockResolvedValue({
      action: "NO_REPLY",
      content: null,
      reason_code: "POLICY_SUPPRESSED",
      handoff_category: null,
    });
    vi.mocked((await import("./services/widgetChat.service")).completeWidgetChatMessage)
      .mockResolvedValue({ reply: "", action: "NO_REPLY", conversationId: 101, attachment: null });

    const res = await doRequest(server, {
      method: "POST",
      path: "/chat",
      headers: {
        "x-widget-site-key": "wsk_test_xxxxxxxx",
        origin: "https://shop.example",
      },
      body: JSON.stringify({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Please help",
        stream: true,
      }),
    });

    expect(agentClientMock.joinCustomerRun).toHaveBeenCalledWith(
      "thread-fast",
      "run-fast",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(res.body).toContain("\"action\":\"NO_REPLY\"");
    expect(res.body).not.toContain("\"error\"");
  });

  it("interrupts only the prepared exact run when the SSE client disconnects before completion", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    vi.mocked(prepareWidgetChatMessage).mockResolvedValue({
      handle: { agentTurnId: 8, threadId: "thread-cancel", runId: "run-cancel" },
      turnParams: {},
      businessProfileId: 20,
      conversationId: 101,
    } as any);
    agentClientMock.joinCustomerRunStream.mockImplementationOnce(
      (_threadId: string, _runId: string, options: { signal: AbortSignal }) => (async function* () {
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      })(),
    );

    await abortAfterFirstSseData(server, JSON.stringify({
      visitorId: "12345678-abcd-ef00-0000-000000000001",
      message: "Please help",
      stream: true,
    }));

    await vi.waitFor(() => expect(agentClientMock.cancelCustomerRun).toHaveBeenCalledWith(
      "thread-cancel",
      "run-cancel",
    ));
  });

  it("sanitizes public SSE errors while logging internal details", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    vi.mocked(prepareWidgetChatMessage).mockRejectedValue(
      new Error("database password leaked"),
    );

    const res = await doRequest(server, {
      method: "POST",
      path: "/chat",
      headers: {
        "x-widget-site-key": "wsk_test_xxxxxxxx",
        origin: "https://shop.example",
      },
      body: JSON.stringify({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Hi there",
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.body).toContain("\"error\":\"Unable to complete chat response.\"");
    expect(res.body).not.toContain("database password leaked");
    expect(res.body).toContain("data: [DONE]");
    expect(logger.error).toHaveBeenCalledWith(
      "widget.chat.stream_failed",
      expect.objectContaining({
        widgetInstallId: 1,
        businessProfileId: 20,
        error: "database password leaked",
      }),
    );
  });
});

describe("OPTIONS /chat (CORS preflight)", () => {
  let server: http.Server;
  let prevNodeEnv: string | undefined;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        vi.clearAllMocks();
        prevNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = "production";
        server = http.createServer(makeApp()).listen(0, "127.0.0.1", resolve);
      }),
  );

  afterEach(
    () =>
      new Promise<void>((resolve, reject) => {
        process.env.NODE_ENV = prevNodeEnv;
        server.close((e) => (e ? reject(e) : resolve()));
      }),
  );

  it("returns 204 with CORS headers when key and origin are valid", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });

    const res = await doRequest(server, {
      method: "OPTIONS",
      path: "/chat",
      headers: {
        "x-widget-site-key": "wsk_test_xxxxxxxx",
        origin: "https://shop.example",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://shop.example",
    );
    expect(res.headers["access-control-allow-methods"]).toMatch(/POST/);
  });

  it("returns 204 for browser preflight without site key header (no DB lookup)", async () => {
    const res = await doRequest(server, {
      method: "OPTIONS",
      path: "/chat",
      headers: {
        origin: "https://shop.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-widget-site-key",
      },
    });

    expect(res.status).toBe(204);
    expect(prisma.widgetInstall.findFirst).not.toHaveBeenCalled();
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://shop.example",
    );
    expect(String(res.headers["access-control-allow-headers"])).toMatch(
      /x-widget-site-key/i,
    );
  });
});
