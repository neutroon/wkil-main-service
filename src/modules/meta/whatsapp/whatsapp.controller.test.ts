import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  enqueueMetaJob: vi.fn(),
  enqueueInboundMetaEvent: vi.fn(),
  verifyMetaWebhookSignature: vi.fn(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@config/env", () => ({
  env: {
    NODE_ENV: "test",
    WHATSAPP_VERIFY_TOKEN: "verify-token",
    FB_APP_SECRET: "app-secret",
  },
}));

vi.mock("@config/prisma", () => ({
  default: {
    whatsAppAccount: { findFirst: mocks.accountFindFirst },
  },
}));

vi.mock("@utils/logger", () => ({
  logger: {
    debug: mocks.loggerDebug,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock("@modules/auth/core/tokenCrypto", () => ({
  decryptFacebookSecret: vi.fn(),
  encryptFacebookSecret: vi.fn(),
}));

vi.mock("@utils/cache", () => ({
  cache: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@middlewares/errorHandler.middleware", () => ({
  AppError: class MockAppError extends Error {},
}));

vi.mock("@modules/meta/core/meta.queue", () => ({
  enqueueMetaJob: mocks.enqueueMetaJob,
  enqueueInboundMetaEvent: mocks.enqueueInboundMetaEvent,
}));

vi.mock("@modules/meta/core/metaWebhook", () => ({
  verifyMetaWebhookSignature: mocks.verifyMetaWebhookSignature,
}));

vi.mock("@modules/meta/whatsapp/whatsappOauth.service", () => ({
  exchangeCodeForToken: vi.fn(),
  discoverWabaAccounts: vi.fn(),
  subscribeWebhook: vi.fn(),
  unsubscribeWebhook: vi.fn(),
  saveWhatsAppAccount: vi.fn(),
  adminTransferAccount: vi.fn(),
}));

vi.mock("@modules/meta/core/conversation.service", () => ({
  listWhatsAppConversations: vi.fn(),
  listConversationMessages: vi.fn(),
  saveMessage: vi.fn(),
}));

vi.mock("@modules/meta/whatsapp/whatsapp.service", () => ({
  sendWhatsAppReply: vi.fn(),
  sendWhatsAppTemplate: vi.fn(),
  listWhatsAppTemplates: vi.fn(),
  sendWhatsAppMedia: vi.fn(),
}));

vi.mock("@modules/meta/core/metaUpload.service", () => ({
  uploadWhatsAppMedia: vi.fn(),
}));

vi.mock("@modules/meta/core/webhookCache.service", () => ({
  invalidateWhatsAppAccountCache: vi.fn(),
}));

vi.mock("@modules/inbox/inbox.routes", () => ({
  getAuthorizedConversation: vi.fn(),
}));

import { whatsappController } from "./whatsapp.controller";
import { WHATSAPP_COEXISTENCE_QUEUE_OPTIONS } from "./whatsappCoexistence.service";

const customerPhone = "201001234567";

function webhookRequest() {
  return {
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "waba-id",
          changes: [
            {
              field: "messages",
              value: {
                metadata: { phone_number_id: "phone-number-id" },
                contacts: [{ profile: { name: "Mona" } }],
                messages: [
                  {
                    id: "wamid-action-1",
                    from: customerPhone,
                    type: "interactive",
                    interactive: {
                      type: "button_reply",
                      button_reply: { id: "opaque-action-token", title: "Confirm" },
                    },
                  },
                  {
                    id: "wamid-echo-1",
                    from: "15551234567",
                    to: customerPhone,
                    type: "text",
                    text: { body: "business echo" },
                  },
                  {
                    id: "wamid-text-1",
                    from: customerPhone,
                    type: "text",
                    text: { body: "hello" },
                  },
                  {
                    id: "wamid-image-1",
                    from: customerPhone,
                    type: "image",
                    image: { id: "media-1", caption: "image caption" },
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    headers: { "x-hub-signature-256": "sha256=test" },
  } as any;
}

describe("WhatsApp webhook controller wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.accountFindFirst.mockResolvedValue({
      businessProfileId: 42,
      displayPhoneNumber: "+15551234567",
    });
    mocks.verifyMetaWebhookSignature.mockReturnValue(true);
    mocks.enqueueMetaJob.mockResolvedValue(undefined);
    mocks.enqueueInboundMetaEvent.mockResolvedValue(undefined);
  });

  it("enqueues interactive actions while preserving echo, text, and media routing", async () => {
    const response = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as any;

    await whatsappController.handleWebhook(webhookRequest(), response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith("EVENT_RECEIVED");
    expect(mocks.enqueueInboundMetaEvent).toHaveBeenCalledTimes(4);

    expect(mocks.enqueueInboundMetaEvent).toHaveBeenNthCalledWith(1, {
      platform: "whatsapp",
      eventId: "wamid-action-1",
      payload: expect.objectContaining({
        type: "ORDER_ACTION",
        orderActionId: "opaque-action-token",
        buttonTitle: "Confirm",
        phoneNumberId: "phone-number-id",
        businessProfileId: 42,
        customerPhone,
        senderId: customerPhone,
        externalId: "wamid-action-1",
        isFromBusiness: false,
      }),
    });
    expect(mocks.enqueueInboundMetaEvent).toHaveBeenNthCalledWith(2, {
      platform: "whatsapp",
      eventId: "wamid-echo-1",
      payload: expect.objectContaining({
        type: "text",
        messageText: "business echo",
        senderId: customerPhone,
        isFromBusiness: true,
      }),
    });
    expect(mocks.enqueueInboundMetaEvent).toHaveBeenNthCalledWith(3, {
      platform: "whatsapp",
      eventId: "wamid-text-1",
      payload: expect.objectContaining({
        type: "text",
        messageText: "hello",
        senderId: customerPhone,
        isFromBusiness: false,
      }),
    });
    expect(mocks.enqueueInboundMetaEvent).toHaveBeenNthCalledWith(4, {
      platform: "whatsapp",
      eventId: "wamid-image-1",
      payload: expect.objectContaining({
        type: "image",
        messageText: "image caption",
        mediaId: "media-1",
        senderId: customerPhone,
        isFromBusiness: false,
      }),
    });
  });

  it("rejects an invalid signature before acknowledging or queueing the webhook", async () => {
    mocks.verifyMetaWebhookSignature.mockReturnValue(false);
    const response = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as any;

    await whatsappController.handleWebhook(webhookRequest(), response);

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.send).toHaveBeenCalledWith("INVALID_SIGNATURE");
    expect(mocks.enqueueMetaJob).not.toHaveBeenCalled();
    expect(mocks.enqueueInboundMetaEvent).not.toHaveBeenCalled();
  });

  it("durably queues recognized delivery receipts with a safe provider error summary", async () => {
    const request = webhookRequest();
    request.body.entry[0].changes[0].value.messages = [];
    request.body.entry[0].changes[0].value.statuses = [
      {
        id: "wamid-outbound-1",
        status: "failed",
        errors: [{ code: 131026, title: "Message undeliverable", details: "private detail" }],
      },
    ];
    const response = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as any;

    await whatsappController.handleWebhook(request, response);

    expect(mocks.enqueueMetaJob).toHaveBeenCalledWith({
      platform: "whatsapp",
      type: "status_update",
      externalId: "wamid-outbound-1",
      statusEvent: "FAILED",
      statusError: "131026: Message undeliverable",
    });
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith("EVENT_RECEIVED");
  });

  it("validates and queues Coexistence history chunks and contacts without treating them as live messages", async () => {
    const request = webhookRequest();
    request.body.entry[0].changes[0] = {
      field: "history",
      value: {
        metadata: { phone_number_id: "phone-number-id" },
        history: [
          {
            metadata: { phase: 0, chunk_order: 1, progress: 100 },
            threads: [{ id: customerPhone, messages: [{ id: "wamid-history-1" }] }],
          },
        ],
      },
    };
    request.body.entry[0].changes.push({
      field: "smb_app_state_sync",
      value: {
        metadata: { phone_number_id: "phone-number-id" },
        state_sync: [{
          type: "contact",
          action: "add",
          contact: { wa_id: customerPhone, full_name: "Mona Customer" },
        }],
      },
    });
    const response = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as any;

    await whatsappController.handleWebhook(request, response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith("EVENT_RECEIVED");
    expect(mocks.accountFindFirst).not.toHaveBeenCalled();
    expect(mocks.enqueueInboundMetaEvent).not.toHaveBeenCalled();
    expect(mocks.enqueueMetaJob).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueMetaJob).toHaveBeenNthCalledWith(
      1,
      {
        platform: "whatsapp",
        type: "whatsapp_coexistence_history",
        wabaId: "waba-id",
        phoneNumberId: "phone-number-id",
        historyChunk: request.body.entry[0].changes[0].value.history[0],
      },
      expect.objectContaining({
        jobId: expect.any(String),
        skipPostEnqueueDiagnostics: true,
        ...WHATSAPP_COEXISTENCE_QUEUE_OPTIONS,
      }),
    );
    expect(mocks.enqueueMetaJob).toHaveBeenNthCalledWith(
      2,
      {
        platform: "whatsapp",
        type: "whatsapp_coexistence_contacts",
        wabaId: "waba-id",
        phoneNumberId: "phone-number-id",
        stateSync: request.body.entry[0].changes[1].value.state_sync,
      },
      expect.objectContaining({
        jobId: expect.any(String),
        skipPostEnqueueDiagnostics: true,
        ...WHATSAPP_COEXISTENCE_QUEUE_OPTIONS,
      }),
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "whatsapp.webhook.coexistence_sync_event_received",
      expect.objectContaining({
        field: "history",
        phoneNumberId: "phone-number-id",
        historyChunks: 1,
        historyMessages: 1,
      }),
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "whatsapp.webhook.coexistence_sync_event_received",
      expect.objectContaining({
        field: "smb_app_state_sync",
        stateSyncItems: 1,
      }),
    );
    expect(JSON.stringify(mocks.loggerInfo.mock.calls)).not.toContain("Mona Customer");
    expect(JSON.stringify(mocks.loggerInfo.mock.calls)).not.toContain(customerPhone);
  });

  it("rejects malformed Coexistence payloads before queueing them", async () => {
    const request = webhookRequest();
    request.body.entry[0].changes[0] = {
      field: "history",
      value: {
        metadata: { phone_number_id: "phone-number-id" },
        history: [{ metadata: {}, threads: [{ id: customerPhone }] }],
      },
    };
    const response = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as any;

    await whatsappController.handleWebhook(request, response);

    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.send).toHaveBeenCalledWith("INVALID_COEXISTENCE_PAYLOAD");
    expect(mocks.enqueueMetaJob).not.toHaveBeenCalled();
    expect(mocks.enqueueInboundMetaEvent).not.toHaveBeenCalled();
  });

  it("acknowledges empty Coexistence sync arrays without queueing no-op jobs", async () => {
    const request = webhookRequest();
    request.body.entry[0].changes = [
      {
        field: "history",
        value: {
          metadata: { phone_number_id: "phone-number-id" },
          history: [],
        },
      },
      {
        field: "smb_app_state_sync",
        value: {
          metadata: { phone_number_id: "phone-number-id" },
          state_sync: [],
        },
      },
    ];
    const response = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as any;

    await whatsappController.handleWebhook(request, response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith("EVENT_RECEIVED");
    expect(mocks.enqueueMetaJob).not.toHaveBeenCalled();
    expect(mocks.enqueueInboundMetaEvent).not.toHaveBeenCalled();
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "whatsapp.webhook.coexistence_sync_event_received",
      expect.objectContaining({ field: "history", historyChunks: 0, historyMessages: 0 }),
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "whatsapp.webhook.coexistence_sync_event_received",
      expect.objectContaining({ field: "smb_app_state_sync", stateSyncItems: 0 }),
    );
  });

  it("enqueues history chunks concurrently without exceeding the bounded concurrency", async () => {
    const request = webhookRequest();
    request.body.entry[0].changes = [{
      field: "history",
      value: {
        metadata: { phone_number_id: "phone-number-id" },
        history: Array.from({ length: 6 }, (_, chunkOrder) => ({
          metadata: { phase: 0, chunk_order: chunkOrder, progress: chunkOrder === 5 ? 100 : 50 },
          threads: [{
            id: customerPhone,
            messages: [{ id: `wamid-history-${chunkOrder}` }],
          }],
        })),
      },
    }];
    let inFlight = 0;
    let maxInFlight = 0;
    mocks.enqueueMetaJob.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      inFlight -= 1;
    });
    const response = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as any;

    await whatsappController.handleWebhook(request, response);

    expect(mocks.enqueueMetaJob).toHaveBeenCalledTimes(6);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(response.status).toHaveBeenCalledWith(200);
    expect(response.send).toHaveBeenCalledWith("EVENT_RECEIVED");
  });

  it("returns a retryable error when durable queueing fails", async () => {
    mocks.enqueueInboundMetaEvent.mockRejectedValueOnce(new Error("queue unavailable"));
    const response = {
      headersSent: false,
      status: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    } as any;

    await whatsappController.handleWebhook(webhookRequest(), response);

    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.send).toHaveBeenCalledWith("WEBHOOK_PROCESSING_FAILED");
  });
});
