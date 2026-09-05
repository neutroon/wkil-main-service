import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@config/prisma", () => ({ default: {} }));
vi.mock("@config/env", () => ({ env: {} }));
vi.mock("@utils/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const mocks = vi.hoisted(() => ({
  decryptFacebookSecret: vi.fn(),
  getSystemSetting: vi.fn(),
  getOrCreateConversation: vi.fn(),
  saveMessage: vi.fn(),
  sendWhatsAppTemplate: vi.fn(),
  sendWhatsAppReply: vi.fn(),
  acquireBusinessSendPermit: vi.fn(),
  markNotificationAttempted: vi.fn(),
  findActiveWhatsAppSuppression: vi.fn(),
  findNotificationForSending: vi.fn(),
  prepareOrderActionTokensForSend: vi.fn(),
  saveNotificationRenderedVariables: vi.fn(),
  resolveActiveTemplateConfig: vi.fn(),
}));

vi.mock("@modules/auth/core/tokenCrypto", () => ({
  decryptFacebookSecret: mocks.decryptFacebookSecret,
}));
vi.mock("@modules/settings/settings.service", () => ({
  getSystemSetting: mocks.getSystemSetting,
}));
vi.mock("@modules/meta/core/conversation.service", () => ({
  getOrCreateConversation: mocks.getOrCreateConversation,
  saveMessage: mocks.saveMessage,
}));
vi.mock("@modules/meta/whatsapp/whatsapp.service", () => ({
  sendWhatsAppTemplate: mocks.sendWhatsAppTemplate,
  sendWhatsAppReply: mocks.sendWhatsAppReply,
}));
vi.mock("./orderConfirmation.rateLimit", () => ({
  acquireBusinessSendPermit: mocks.acquireBusinessSendPermit,
}));
vi.mock("./orderConfirmation.repository", () => ({
  findActiveWhatsAppSuppression: mocks.findActiveWhatsAppSuppression,
  findNotificationForSending: mocks.findNotificationForSending,
  markNotificationAttempted: mocks.markNotificationAttempted,
  prepareOrderActionTokensForSend: mocks.prepareOrderActionTokensForSend,
  saveNotificationRenderedVariables: mocks.saveNotificationRenderedVariables,
}));
vi.mock("./orderConfirmation.template.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("./orderConfirmation.template.service")>(),
  resolveActiveTemplateConfig: mocks.resolveActiveTemplateConfig,
  validateOrderTemplateMapping: vi.fn((mapping: unknown) => mapping),
  renderOrderTemplateVariables: vi.fn(
    (_order: unknown, _mapping: unknown, actionTokens: { confirm: string; cancel: string }, _locale: string) => ({
      body: ["Mona", "USD 10.00"],
      buttons: actionTokens,
      previewText: "Order #100",
    }),
  ),
}));

import { hashOrderActionToken } from "./orderConfirmation.crypto";
import { sendConfirmationNotification } from "./orderConfirmation.whatsapp.adapter";

const notification = {
  id: 18,
  businessProfileId: 11,
  orderId: 12,
  kind: "CONFIRMATION_REQUEST",
  locale: "ar",
  status: "SENDING",
  renderedVariables: null,
  templateConfig: {
    id: 4,
    templateName: "stale_snapshot",
    languageCode: "en",
    variableMapping: {
      body: ["orderNumber"],
      buttons: ["confirmToken", "cancelToken"],
    },
  },
  order: {
    id: 12,
    businessProfileId: 11,
    integrationId: 7,
    externalOrderId: "ord-1",
    orderNumber: "#100",
    status: "AWAITING_CONFIRMATION",
    customerPhone: "+12025550123",
    customerName: "Mona",
    locale: "ar",
    total: "10.00",
    currency: "USD",
    lineItems: null,
    shippingAddress: null,
    integration: {
      id: 7,
      whatsappAccountId: 9,
      defaultLocale: "en",
      storeSyncEnabled: false,
      whatsappAccount: {
        id: 9,
        phoneNumberId: "phone-1",
        accessToken: "encrypted-access-token",
      },
    },
  },
  actionTokens: [] as Array<{ action: "CONFIRM" | "CANCEL"; tokenHash: string }>,
};

describe("WhatsApp confirmation adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSystemSetting.mockResolvedValue("true");
    mocks.findActiveWhatsAppSuppression.mockResolvedValue(null);
    mocks.decryptFacebookSecret.mockReturnValue("plain-access-token");
    mocks.resolveActiveTemplateConfig.mockResolvedValue({
      id: 8,
      businessProfileId: 11,
      whatsappAccountId: 9,
      eventType: "order.created",
      locale: "ar",
      templateName: "current_approved_template",
      languageCode: "ar",
      templateVersion: 3,
      isActive: true,
      approvalStatus: "APPROVED",
      variableMapping: {
        body: ["customerName", "total"],
        buttons: ["confirmToken", "cancelToken"],
      },
    });
    mocks.prepareOrderActionTokensForSend.mockResolvedValue({
      confirmToken: "raw-confirm-token",
      cancelToken: "raw-cancel-token",
      confirmTokenHash: hashOrderActionToken("raw-confirm-token"),
      cancelTokenHash: hashOrderActionToken("raw-cancel-token"),
    });
    mocks.saveNotificationRenderedVariables.mockResolvedValue(undefined);
    mocks.acquireBusinessSendPermit.mockResolvedValue(null);
    mocks.markNotificationAttempted.mockResolvedValue(undefined);
    mocks.sendWhatsAppTemplate.mockResolvedValue({ messages: [{ id: "wamid-1" }] });
    mocks.getOrCreateConversation.mockResolvedValue({ id: 77 });
    mocks.saveMessage.mockResolvedValue({ id: 88 });
    mocks.findNotificationForSending.mockResolvedValue(notification);
  });

  it("uses fresh opaque tokens as button payloads and hashes verify them", async () => {
    await sendConfirmationNotification(18);

    const components = mocks.sendWhatsAppTemplate.mock.calls[0]?.[3] as Array<{
      type: string;
      parameters?: Array<{ payload?: string }>;
    }>;
    const buttonPayloads = components
      .filter((component) => component.type === "button")
      .map((component) => component.parameters?.[0]?.payload);

    expect(buttonPayloads).toEqual(["raw-confirm-token", "raw-cancel-token"]);
    expect(buttonPayloads[0]).not.toBe(notification.actionTokens[0]?.tokenHash);
    expect(hashOrderActionToken(buttonPayloads[0] as string)).toBe(
      hashOrderActionToken("raw-confirm-token"),
    );
    expect(JSON.stringify(mocks.saveNotificationRenderedVariables.mock.calls)).not.toContain(
      "raw-confirm-token",
    );
    expect(mocks.saveNotificationRenderedVariables).toHaveBeenCalledWith(
      18,
      expect.objectContaining({ buttonMapping: ["confirmToken", "cancelToken"] }),
      8,
    );
  });

  it("sends notification-only templates with body parameters and no action tokens", async () => {
    const config = await mocks.resolveActiveTemplateConfig();
    mocks.resolveActiveTemplateConfig.mockResolvedValue({ ...config, variableMapping: { body: ["customerName", "total"] } });

    await sendConfirmationNotification(18);

    expect(mocks.prepareOrderActionTokensForSend).not.toHaveBeenCalled();
    expect(mocks.sendWhatsAppTemplate.mock.calls[0][3]).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Mona" }, { type: "text", text: "USD 10.00" }] },
    ]);
    expect(mocks.saveNotificationRenderedVariables).toHaveBeenCalledWith(18,
      expect.objectContaining({ buttonMapping: [], mode: "NOTIFICATION_ONLY" }), 8);
  });

  it("resolves and validates the current template before consuming the send permit", async () => {
    await sendConfirmationNotification(18);

    expect(mocks.resolveActiveTemplateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        integrationId: 7,
        businessProfileId: 11,
        whatsappAccountId: 9,
        locale: "ar",
      }),
    );
    expect(mocks.acquireBusinessSendPermit.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.resolveActiveTemplateConfig.mock.invocationCallOrder[0],
    );
    expect(mocks.acquireBusinessSendPermit.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.sendWhatsAppTemplate.mock.invocationCallOrder[0],
    );
  });

  it("stops before the permit or provider when the global switch is disabled", async () => {
    mocks.getSystemSetting.mockResolvedValue("false");

    await expect(sendConfirmationNotification(18)).rejects.toMatchObject({
      code: "GLOBAL_KILL_SWITCH",
    });

    expect(mocks.acquireBusinessSendPermit).not.toHaveBeenCalled();
    expect(mocks.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("classifies a transport failure as ambiguous to prevent duplicate sends", async () => {
    mocks.sendWhatsAppTemplate.mockRejectedValueOnce(new TypeError("fetch failed"));

    await expect(sendConfirmationNotification(18)).rejects.toMatchObject({
      code: "AMBIGUOUS_PROVIDER_DELIVERY",
    });
  });

  it("does not resend when inbox mirroring fails after Meta accepted the message", async () => {
    mocks.saveMessage.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(sendConfirmationNotification(18)).resolves.toEqual({
      providerMessageId: "wamid-1",
      previewText: "Order #100: Mona | USD 10.00",
    });
    expect(mocks.sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
  });
});
