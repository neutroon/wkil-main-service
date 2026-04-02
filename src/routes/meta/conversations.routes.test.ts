/**
 * Unit tests for GET /conversations, GET /conversations/:id/messages,
 * and PATCH /conversations/:id/read.
 *
 * Service functions and Prisma calls are stubbed — no database required.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { Application } from "express";
import http from "http";

// ── Stub the service helpers the routes use ─────────────────────────────────
vi.mock("../../services/meta/conversation.service", () => ({
  listWhatsAppConversations: vi.fn(),
  listConversationMessages: vi.fn(),
  getConversationForUser: vi.fn(),
  saveMessage: vi.fn(),
}));

vi.mock("../../services/meta/whatsapp.service", () => ({
  sendWhatsAppReply: vi.fn(),
}));

vi.mock("../../utils/tokenCrypto", () => ({
  decryptFacebookSecret: vi.fn((v: string) => `decrypted-${v}`),
}));

// ── Stub prisma (used directly in the route for WA account lookups) ──────────
vi.mock("../../config/prisma", () => ({
  default: {
    whatsAppAccount: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    conversation: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

// ── Stub auth ────────────────────────────────────────────────────────────────
vi.mock("../../middlewares/auth.middleware", () => ({
  authenticateToken: (req: any, _res: any, next: () => void) => {
    req.user = { id: 42 };
    next();
  },
}));

import conversationsRoutes from "./conversations.routes";
import * as convService from "../../services/meta/conversation.service";
import * as waService from "../../services/meta/whatsapp.service";
import prisma from "../../config/prisma";

const mockListConversations = vi.mocked(convService.listWhatsAppConversations);
const mockListMessages = vi.mocked(convService.listConversationMessages);
const mockGetConvForUser = vi.mocked(convService.getConversationForUser);
const mockSaveMessage = vi.mocked(convService.saveMessage);
const mockSendReply = vi.mocked(waService.sendWhatsAppReply);
const mockWaFindMany = vi.mocked((prisma as any).whatsAppAccount.findMany);
const mockWaFindFirst = vi.mocked((prisma as any).whatsAppAccount.findFirst);
const mockConvUpdate = vi.mocked((prisma as any).conversation.update);

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function makeApp(): Application {
  const app = express();
  app.use(express.json());
  app.use("/", conversationsRoutes);
  return app;
}

function doRequest(
  server: http.Server,
  opts: { method: string; path: string; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const rawBody = opts.body != null ? Buffer.from(JSON.stringify(opts.body)) : Buffer.alloc(0);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: addr.port,
        path: opts.path,
        method: opts.method,
        headers: {
          "content-type": "application/json",
          "content-length": String(rawBody.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              json: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          } catch {
            resolve({ status: res.statusCode ?? 0, json: null });
          }
        });
      },
    );
    req.on("error", reject);
    if (rawBody.length) req.write(rawBody);
    req.end();
  });
}

function withServer(app: Application): Promise<http.Server> {
  return new Promise((resolve) => {
    const s = http.createServer(app).listen(0, "127.0.0.1", () => resolve(s));
  });
}

function closeServer(s: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    s.close((e) => (e ? reject(e) : resolve())),
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /conversations", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns empty data when user has no WA accounts", async () => {
    mockListConversations.mockResolvedValue({
      data: [],
      meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
    });

    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "GET", path: "/" });
    await closeServer(server);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      data: [],
      meta: { total: 0, page: 1, limit: 20, totalPages: 0 },
    });
  });

  it("returns conversations for the authenticated user", async () => {
    const fakeData = [
      {
        id: 1,
        businessProfileId: 9,
        phoneNumberId: "PHONE_1",
        displayPhoneNumber: "+1 555 000 1234",
        customerPhone: "15550001111",
        channel: "whatsapp",
        lastMessage: { role: "user", content: "Hello!", createdAt: new Date() },
        updatedAt: new Date(),
        createdAt: new Date(),
      },
    ];

    mockListConversations.mockResolvedValue({
      data: fakeData,
      meta: { total: 1, page: 1, limit: 10, totalPages: 1 },
    });

    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "GET", path: "/?page=1&limit=10" });
    await closeServer(server);

    expect(res.status).toBe(200);
    const body = res.json as any;
    expect(body.meta.total).toBe(1);
    expect(body.data[0].channel).toBe("whatsapp");
    expect(mockListConversations).toHaveBeenCalledWith(42, 1, 10);
  });
});

describe("GET /conversations/:id/messages", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 for non-numeric id", async () => {
    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "GET", path: "/abc/messages" });
    await closeServer(server);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "Invalid conversation id" });
  });

  it("returns 404 when user has no WA accounts", async () => {
    mockWaFindMany.mockResolvedValue([]);

    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "GET", path: "/1/messages" });
    await closeServer(server);
    expect(res.status).toBe(404);
  });

  it("returns 404 when conversation doesn't belong to the user", async () => {
    mockWaFindMany.mockResolvedValue([{ phoneNumberId: "MY_PHONE" }]);
    mockGetConvForUser.mockResolvedValue(null);

    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "GET", path: "/999/messages" });
    await closeServer(server);

    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: "Conversation not found" });
  });

  it("returns messages and conversation metadata for a valid id", async () => {
    const fakeConversation = {
      id: 5,
      businessProfileId: 9,
      pageId: "PHONE_1",
      senderId: "15550001111",
      channel: "whatsapp",
      customerPhone: "15550001111",
      updatedAt: new Date(),
      createdAt: new Date(),
    };

    mockWaFindMany
      .mockResolvedValueOnce([{ phoneNumberId: "PHONE_1" }]) // getUserPhoneNumberIds
      .mockResolvedValueOnce([{ displayPhoneNumber: "+1 555 000 1234" }]); // enrich display phone

    mockGetConvForUser.mockResolvedValue(fakeConversation as any);
    mockListMessages.mockResolvedValue({
      data: [
        { id: 10, role: "user", content: "Hi there!", createdAt: new Date() },
        { id: 11, role: "model", content: "How can I help?", createdAt: new Date() },
      ] as any,
      meta: { total: 2, page: 1, limit: 50, totalPages: 1 },
    });

    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "GET", path: "/5/messages" });
    await closeServer(server);

    expect(res.status).toBe(200);
    const body = res.json as any;
    expect(body.conversation.id).toBe(5);
    expect(body.conversation.customerPhone).toBe("15550001111");
    expect(body.data).toHaveLength(2);
    expect(body.meta.total).toBe(2);
  });
});

describe("PATCH /conversations/:id/read", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 for non-numeric id", async () => {
    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "PATCH", path: "/xyz/read" });
    await closeServer(server);
    expect(res.status).toBe(400);
  });

  it("returns 404 when conversation not found", async () => {
    mockWaFindMany.mockResolvedValue([{ phoneNumberId: "PHONE_1" }]);
    mockGetConvForUser.mockResolvedValue(null);

    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "PATCH", path: "/1/read" });
    await closeServer(server);
    expect(res.status).toBe(404);
  });

  it("returns { success: true } for a valid conversation", async () => {
    const fakeConversation = {
      id: 1,
      pageId: "PHONE_1",
      senderId: "15550001111",
      channel: "whatsapp",
      customerPhone: "15550001111",
      updatedAt: new Date(),
      createdAt: new Date(),
    };

    mockWaFindMany.mockResolvedValue([{ phoneNumberId: "PHONE_1" }]);
    mockGetConvForUser.mockResolvedValue(fakeConversation as any);
    mockConvUpdate.mockResolvedValue(fakeConversation);

    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "PATCH", path: "/1/read" });
    await closeServer(server);

    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: true });
  });
});
describe("POST /conversations/:id/messages", () => {
  beforeEach(() => vi.clearAllMocks());

  const fakeConversation = {
    id: 7,
    pageId: "PHONE_1",
    senderId: "15550001111",
    channel: "whatsapp",
    customerPhone: "15550001111",
    updatedAt: new Date(),
    createdAt: new Date(),
  };

  it("returns 400 for non-numeric id", async () => {
    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "POST", path: "/abc/messages", body: { text: "hi" } });
    await closeServer(server);
    expect(res.status).toBe(400);
  });

  it("returns 400 when text is missing", async () => {
    mockWaFindMany.mockResolvedValue([{ phoneNumberId: "PHONE_1" }]);
    mockGetConvForUser.mockResolvedValue(fakeConversation as any);
    mockWaFindFirst.mockResolvedValue({ accessToken: "tok", phoneNumberId: "PHONE_1" });

    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "POST", path: "/7/messages", body: {} });
    await closeServer(server);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: "text is required" });
  });

  it("returns 404 when user has no WA accounts", async () => {
    mockWaFindMany.mockResolvedValue([]);
    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "POST", path: "/7/messages", body: { text: "Hello" } });
    await closeServer(server);
    expect(res.status).toBe(404);
  });

  it("returns 502 when Cloud API call fails", async () => {
    mockWaFindMany.mockResolvedValue([{ phoneNumberId: "PHONE_1" }]);
    mockGetConvForUser.mockResolvedValue(fakeConversation as any);
    mockWaFindFirst.mockResolvedValue({ accessToken: "tok", phoneNumberId: "PHONE_1" });
    mockSendReply.mockRejectedValue(new Error("Cloud API error"));

    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "POST", path: "/7/messages", body: { text: "Hello" } });
    await closeServer(server);

    expect(res.status).toBe(502);
    expect(res.json).toMatchObject({ error: "WhatsApp Cloud API error" });
  });

  it("sends message and returns 201 with saved record", async () => {
    const savedMsg = { id: 99, role: "model", content: "Hello!", createdAt: new Date() };

    mockWaFindMany.mockResolvedValue([{ phoneNumberId: "PHONE_1" }]);
    mockGetConvForUser.mockResolvedValue(fakeConversation as any);
    mockWaFindFirst.mockResolvedValue({ accessToken: "enc-tok", phoneNumberId: "PHONE_1" });
    mockSendReply.mockResolvedValue(undefined);
    mockSaveMessage.mockResolvedValue(savedMsg as any);

    const server = await withServer(makeApp());
    const res = await doRequest(server, { method: "POST", path: "/7/messages", body: { text: "Hello!" } });
    await closeServer(server);

    expect(res.status).toBe(201);
    const body = res.json as any;
    expect(body.data.role).toBe("model");
    expect(body.data.content).toBe("Hello!");

    // Cloud API called with correct args
    expect(mockSendReply).toHaveBeenCalledWith(
      "15550001111", "Hello!", "PHONE_1", "decrypted-enc-tok",
    );
    // Message persisted
    expect(mockSaveMessage).toHaveBeenCalledWith(7, "model", "Hello!");
  });
});
