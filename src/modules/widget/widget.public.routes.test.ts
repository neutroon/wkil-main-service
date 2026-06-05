/**
 * Public widget chat — HTTP tests with mocked Prisma + chat service.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import express, { Application } from "express";
import type { WidgetInstall } from "@prisma/client";

vi.mock("@config/prisma", () => ({
  default: {
    widgetInstall: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock("./services/widgetChat.service", () => ({
  processWidgetChatMessage: vi.fn(),
}));

vi.mock("@utils/logger", () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import widgetPublicRoutes from "./widget.public.routes";
import prisma from "@config/prisma";
import { processWidgetChatMessage } from "@modules/widget/services/widgetChat.service";
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

const baseInstall: WidgetInstall = {
  id: 1,
  userId: 10,
  businessProfileId: 20,
  publicSiteKey: "wsk_test_xxxxxxxx",
  allowedOrigins: ["https://shop.example"],
  label: null,
  isActive: true,
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
    vi.mocked(processWidgetChatMessage).mockResolvedValue({
      reply: "Hello from SSE widget",
      conversationId: 101,
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
    expect(res.body).toContain("data: [DONE]");
  });

  it("sanitizes public SSE errors while logging internal details", async () => {
    vi.mocked(prisma.widgetInstall.findFirst).mockResolvedValue({
      ...baseInstall,
      allowedOrigins: ["https://shop.example"],
    });
    vi.mocked(processWidgetChatMessage).mockRejectedValue(
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




