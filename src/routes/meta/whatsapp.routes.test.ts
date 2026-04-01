/**
 * Lightweight webhook tests — no supertest dependency.
 * Uses Node's built-in http.request via a simple helper.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import http from "http";
import express, { Application } from "express";

// ── Stubs ─────────────────────────────────────────────────────────────────────
vi.mock("../../config/prisma", () => ({
  default: {
    processedWhatsAppMessage: {
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    whatsAppAccount: {
      upsert: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    businessProfile: { findFirst: vi.fn() },
  },
}));

vi.mock("../../queues/whatsapp.queue", () => ({
  enqueueWhatsAppJob: vi.fn(),
}));

vi.mock("../../middlewares/auth.middleware", () => ({
  authenticateToken: (_req: any, _res: any, next: () => void) => next(),
}));

vi.mock("../../utils/tokenCrypto", () => ({
  encryptFacebookSecret: (v: string) => v,
}));

import whatsappRoutes from "./whatsapp.routes";
import { enqueueWhatsAppJob } from "../../queues/whatsapp.queue";

// ── Tiny HTTP helper ──────────────────────────────────────────────────────────

const APP_SECRET = "test_app_secret";

function makeApp(): Application {
  const app = express();
  app.use("/webhook", express.raw({ type: "application/json" }));
  app.use(express.json());
  app.use("/", whatsappRoutes);
  return app;
}

function sign(body: Buffer): string {
  return "sha256=" + createHmac("sha256", APP_SECRET).update(body).digest("hex");
}

/** HTTP helper that wraps http.request in a Promise. */
function doRequest(
  server: http.Server,
  opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: Buffer | string;
  },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const rawBody = opts.body;
    const payload =
      rawBody instanceof Buffer
        ? rawBody
        : typeof rawBody === "string"
        ? Buffer.from(rawBody, "utf8")
        : Buffer.alloc(0);

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
          }),
        );
      },
    );
    req.on("error", reject);
    if (payload.length) req.write(payload);
    req.end();
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("WhatsApp webhook", () => {
  let server: http.Server;

  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        vi.clearAllMocks();
        process.env.WHATSAPP_VERIFY_TOKEN = "my_verify_token";
        process.env.FB_APP_SECRET = APP_SECRET;
        server = http.createServer(makeApp()).listen(0, "127.0.0.1", resolve);
      }),
  );

  afterEach(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  );

  // ── GET /webhook ──────────────────────────────────────────────────────────

  it("GET /webhook returns 200 + challenge when token matches", async () => {
    const res = await doRequest(server, {
      method: "GET",
      path: "/webhook?hub.mode=subscribe&hub.verify_token=my_verify_token&hub.challenge=HELLO",
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("HELLO");
  });

  it("GET /webhook returns 403 when token is wrong", async () => {
    const res = await doRequest(server, {
      method: "GET",
      path: "/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=HELLO",
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body)).toMatchObject({ error: "Verification failed" });
  });

  // ── POST /webhook ─────────────────────────────────────────────────────────

  it("POST /webhook ACKs non-whatsapp objects without enqueueing", async () => {
    const body = Buffer.from(JSON.stringify({ object: "page", entry: [] }));
    const res = await doRequest(server, {
      method: "POST",
      path: "/webhook",
      headers: { "x-hub-signature-256": sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(enqueueWhatsAppJob).not.toHaveBeenCalled();
  });

  it("POST /webhook enqueues valid inbound text message", async () => {
    const body = Buffer.from(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "WABA_ID",
            changes: [
              {
                field: "messages",
                value: {
                  messaging_product: "whatsapp",
                  metadata: { phone_number_id: "PHONE_ID" },
                  messages: [
                    {
                      id: "wamid.test123",
                      from: "15551234567",
                      type: "text",
                      text: { body: "Hello!" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );

    const res = await doRequest(server, {
      method: "POST",
      path: "/webhook",
      headers: { "x-hub-signature-256": sign(body) },
      body,
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(enqueueWhatsAppJob).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneNumberId: "PHONE_ID",
        from: "15551234567",
        messageText: "Hello!",
        wamid: "wamid.test123",
      }),
    );
  });

  it("POST /webhook ACKs but does NOT enqueue when HMAC is invalid", async () => {
    const body = Buffer.from(
      JSON.stringify({ object: "whatsapp_business_account", entry: [] }),
    );
    const res = await doRequest(server, {
      method: "POST",
      path: "/webhook",
      headers: { "x-hub-signature-256": "sha256=badhash" },
      body,
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(enqueueWhatsAppJob).not.toHaveBeenCalled();
  });
});
