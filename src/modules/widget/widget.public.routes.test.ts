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
  completeWidgetChatMessage,
  prepareWidgetChatMessage,
  processWidgetChatMessage,
  failWidgetChatMessage,
} from "@modules/widget/services/widgetChat.service";
import { logger } from "@utils/logger";
import { errorHandler } from "@middlewares/errorHandler.middleware";

function makeApp(): Application {
  const app = express();
  app.use(express.json({ limit: "32kb" }));
  app.use(widgetPublicRoutes);
  app.use(errorHandler);
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

function abortRequest(
  server: http.Server,
  opts: {
    path: string;
    headers?: Record<string, string>;
    body: string;
  },
  afterStarted: () => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const payload = Buffer.from(opts.body, "utf8");
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: opts.path,
        method: "POST",
        headers: {
          "content-length": String(payload.length),
          ...opts.headers,
        },
      },
      () => reject(new Error("aborted request unexpectedly received a response")),
    );
    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
    req.on("close", resolve);
    req.end(payload);
    void afterStarted()
      .then(() => req.destroy())
      .catch(reject);
  });
}

function multipartBody(): { body: string; contentType: string } {
  const boundary = "----wkil-widget-test-boundary";
  const body = [
    `--${boundary}\r\nContent-Disposition: form-data; name="visitorId"\r\n\r\n12345678-abcd-ef00-0000-000000000001\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nPlease inspect this\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\nhello\r\n`,
    `--${boundary}--\r\n`,
  ].join("");
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
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
      expect.any(AbortSignal),
    );
    expect(res.headers["access-control-allow-origin"]).toBe(
      "https://shop.example",
    );
  });

  it("returns a stable retryable error without exposing agent failure details", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    vi.mocked(processWidgetChatMessage).mockRejectedValue(
      new Error("private agent provider detail"),
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
      }),
    });

    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      status: "error",
      message: "Unable to complete chat response.",
      code: "WIDGET_CHAT_UNAVAILABLE",
    });
    expect(res.body).not.toContain("private agent provider detail");
    expect(res.body).not.toContain("debug");
  });

  it("aborts shared JSON processing on /chat response disconnect without writing a 500", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    let signal: AbortSignal | undefined;
    vi.mocked(processWidgetChatMessage).mockImplementationOnce(async (_params, requestSignal) => {
      signal = requestSignal;
      await new Promise<void>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
      });
      throw new Error("request aborted");
    });

    await abortRequest(server, {
      path: "/chat",
      headers: {
        "content-type": "application/json",
        "x-widget-site-key": "wsk_test_xxxxxxxx",
        origin: "https://shop.example",
      },
      body: JSON.stringify({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Please wait",
      }),
    }, async () => {
      await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    });

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("uses the same disconnect-safe JSON transport for successful media chat", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    vi.mocked(processWidgetChatMessage).mockResolvedValueOnce({
      reply: "I can inspect that",
      conversationId: 100,
      action: "REPLY",
      attachment: null,
    });
    const multipart = multipartBody();

    const res = await doRequest(server, {
      method: "POST",
      path: "/chat/media",
      headers: {
        "content-type": multipart.contentType,
        "x-widget-site-key": "wsk_test_xxxxxxxx",
        origin: "https://shop.example",
      },
      body: multipart.body,
    });

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      reply: "I can inspect that",
      conversationId: 100,
      action: "REPLY",
      attachment: null,
    });
    expect(processWidgetChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        install: expect.objectContaining({ id: 1 }),
        message: "Please inspect this",
        media: expect.objectContaining({ originalName: "note.txt" }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("aborts shared JSON processing on /chat/media response disconnect", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    let signal: AbortSignal | undefined;
    vi.mocked(processWidgetChatMessage).mockImplementationOnce(async (_params, requestSignal) => {
      signal = requestSignal;
      await new Promise<void>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
      });
      throw new Error("request aborted");
    });
    const multipart = multipartBody();

    await abortRequest(server, {
      path: "/chat/media",
      headers: {
        "content-type": multipart.contentType,
        "x-widget-site-key": "wsk_test_xxxxxxxx",
        origin: "https://shop.example",
      },
      body: multipart.body,
    }, async () => {
      await vi.waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
    });

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(logger.error).not.toHaveBeenCalled();
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
    const [initialFrame] = res.body.split("\n\n");
    expect(JSON.parse(initialFrame.replace(/^data:\s*/, ""))).toEqual({
      status: "processing",
      event: "values",
    });
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
      { signal: expect.any(AbortSignal) },
    );
    expect(res.body).toContain("\"event\":\"values\"");
    expect(res.body).toContain("\"action\":\"HANDOFF\"");
    expect(streamExhausted).toBe(true);
    expect(agentClientMock.joinCustomerRun).toHaveBeenCalledWith(
      "thread-1",
      "run-1",
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
    vi.mocked(completeWidgetChatMessage)
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
    );
    expect(res.body).toContain("\"action\":\"NO_REPLY\"");
    expect(res.body).not.toContain("\"error\"");
  });

  it("does not cancel or fail a terminal run when the client closes during final-state retrieval", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    vi.mocked(prepareWidgetChatMessage).mockResolvedValue({
      handle: { agentTurnId: 8, threadId: "thread-terminal", runId: "run-terminal" },
      turnParams: {},
      businessProfileId: 20,
      conversationId: 101,
    } as any);

    let streamExhausted = false;
    let finalJoinStarted = false;
    let releaseFinalJoin!: () => void;
    const finalJoinReleased = new Promise<void>((resolve) => { releaseFinalJoin = resolve; });
    agentClientMock.joinCustomerRunStream.mockReturnValue((async function* () {
      yield { event: "metadata", data: { run_id: "run-terminal", phase: "complete" } };
      streamExhausted = true;
    })());
    const finalDecision = {
      action: "NO_REPLY",
      content: null,
      reason_code: "POLICY_SUPPRESSED",
      handoff_category: null,
    };
    agentClientMock.joinCustomerRun.mockImplementationOnce(async () => {
      finalJoinStarted = true;
      await finalJoinReleased;
      return finalDecision;
    });
    vi.mocked((await import("./services/widgetChat.service")).completeWidgetChatMessage)
      .mockResolvedValue({ reply: "", action: "NO_REPLY", conversationId: 101, attachment: null });

    const requestClosed = new Promise<void>((resolve, reject) => {
      const addr = server.address() as { port: number };
      const req = http.request({
        hostname: "127.0.0.1",
        port: addr.port,
        path: "/chat",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(JSON.stringify({
            visitorId: "12345678-abcd-ef00-0000-000000000001",
            message: "Please wait",
            stream: true,
          }))),
          "x-widget-site-key": "wsk_test_xxxxxxxx",
          origin: "https://shop.example",
        },
      });
      req.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
      });
      req.on("close", resolve);
      req.end(JSON.stringify({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Please wait",
        stream: true,
      }));

      void (async () => {
        await vi.waitFor(() => expect(streamExhausted).toBe(true));
        await vi.waitFor(() => expect(finalJoinStarted).toBe(true));
        req.destroy();
      })().catch(reject);
    });

    await requestClosed;
    releaseFinalJoin();
    await vi.waitFor(() => expect(completeWidgetChatMessage).toHaveBeenCalled());

    expect(agentClientMock.cancelCustomerRun).not.toHaveBeenCalled();
    expect(failWidgetChatMessage).not.toHaveBeenCalled();
  });

  it("finalizes a terminal run when exact final-state retrieval rejects after disconnect", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    const prepared = {
      handle: { agentTurnId: 8, threadId: "thread-terminal-failure", runId: "run-terminal-failure" },
      turnParams: {},
      businessProfileId: 20,
      conversationId: 101,
    } as any;
    vi.mocked(prepareWidgetChatMessage).mockResolvedValue(prepared);

    let streamExhausted = false;
    let finalJoinStarted = false;
    let rejectFinalJoin!: (error: Error) => void;
    const finalJoinRejected = new Promise<never>((_resolve, reject) => { rejectFinalJoin = reject; });
    agentClientMock.joinCustomerRunStream.mockReturnValue((async function* () {
      yield { event: "metadata", data: { run_id: "run-terminal-failure", phase: "complete" } };
      streamExhausted = true;
    })());
    agentClientMock.joinCustomerRun.mockImplementationOnce(async () => {
      finalJoinStarted = true;
      return finalJoinRejected;
    });
    vi.mocked(completeWidgetChatMessage).mockResolvedValue({
      reply: "",
      action: "NO_REPLY",
      conversationId: 101,
      attachment: null,
    });

    const requestClosed = new Promise<void>((resolve, reject) => {
      const addr = server.address() as { port: number };
      const req = http.request({
        hostname: "127.0.0.1",
        port: addr.port,
        path: "/chat",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(JSON.stringify({
            visitorId: "12345678-abcd-ef00-0000-000000000001",
            message: "Please wait",
            stream: true,
          }))),
          "x-widget-site-key": "wsk_test_xxxxxxxx",
          origin: "https://shop.example",
        },
      });
      req.on("error", (error) => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
      });
      req.on("close", resolve);
      req.end(JSON.stringify({
        visitorId: "12345678-abcd-ef00-0000-000000000001",
        message: "Please wait",
        stream: true,
      }));

      void (async () => {
        await vi.waitFor(() => expect(streamExhausted).toBe(true));
        await vi.waitFor(() => expect(finalJoinStarted).toBe(true));
        req.destroy();
        await requestClosed;
        rejectFinalJoin(new Error("provider payload contains customer secret"));
      })().catch(reject);
    });

    await requestClosed;
    await vi.waitFor(() => expect(failWidgetChatMessage).toHaveBeenCalledWith(
      prepared,
      expect.objectContaining({ message: "provider payload contains customer secret" }),
    ));

    expect(agentClientMock.cancelCustomerRun).not.toHaveBeenCalled();
    expect(completeWidgetChatMessage).not.toHaveBeenCalled();
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
    agentClientMock.cancelCustomerRun.mockRejectedValueOnce(new Error("provider credential leaked"));

    await abortAfterFirstSseData(server, JSON.stringify({
      visitorId: "12345678-abcd-ef00-0000-000000000001",
      message: "Please help",
      stream: true,
    }));

    await vi.waitFor(() => expect(agentClientMock.cancelCustomerRun).toHaveBeenCalledWith(
      "thread-cancel",
      "run-cancel",
    ));
    expect(agentClientMock.cancelCustomerRun).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
      "widget.chat.cancel_failed",
      expect.objectContaining({
        widgetInstallId: 1,
        businessProfileId: 20,
        errorCode: "CUSTOMER_AGENT_FAILURE",
        correlationId: expect.any(String),
      }),
    ));
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("provider credential leaked");
  });

  it("sanitizes public SSE errors and keeps finalization and stream logs redacted", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    const prepared = {
      handle: { agentTurnId: 8, threadId: "thread-error", runId: "run-error" },
      turnParams: {},
      businessProfileId: 20,
      conversationId: 101,
    } as any;
    vi.mocked(prepareWidgetChatMessage).mockResolvedValue(prepared);
    agentClientMock.joinCustomerRunStream.mockReturnValue((async function* () {
      throw new Error("database password leaked");
    })());
    vi.mocked(failWidgetChatMessage).mockRejectedValueOnce(new Error("SQL credential leaked"));

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
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledWith(
      "widget.chat.finalize_failed",
      expect.objectContaining({
        widgetInstallId: 1,
        businessProfileId: 20,
        errorCode: "CUSTOMER_AGENT_FAILURE",
        correlationId: expect.any(String),
      }),
    ));
    expect(logger.error).toHaveBeenCalledWith(
      "widget.chat.stream_failed",
      expect.objectContaining({
        widgetInstallId: 1,
        businessProfileId: 20,
        errorCode: "CUSTOMER_AGENT_FAILURE",
        correlationId: expect.any(String),
      }),
    );
    const serializedLogs = JSON.stringify([
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
    ]);
    expect(serializedLogs).not.toContain("database password leaked");
    expect(serializedLogs).not.toContain("SQL credential leaked");
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
