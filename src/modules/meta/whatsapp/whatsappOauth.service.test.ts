import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  accountUpsert: vi.fn(),
  accountUpdate: vi.fn(),
  encryptFacebookSecret: vi.fn(),
  registrationPin: undefined as string | undefined,
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@config/env", () => ({
  env: {
    FB_API_URL: "https://graph.facebook.com/v25.0",
    FB_APP_ID: "app-id",
    FB_APP_SECRET: "app-secret",
    get WHATSAPP_REGISTRATION_PIN() {
      return mocks.registrationPin;
    },
  },
}));

vi.mock("@config/prisma", () => ({
  default: {
    whatsAppAccount: {
      findFirst: mocks.accountFindFirst,
      upsert: mocks.accountUpsert,
      update: mocks.accountUpdate,
    },
  },
}));

vi.mock("@modules/auth/core/tokenCrypto", () => ({
  encryptFacebookSecret: mocks.encryptFacebookSecret,
}));

vi.mock("@utils/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

vi.mock("@middlewares/errorHandler.middleware", () => ({
  AppError: class MockAppError extends Error {
    statusCode: number;

    constructor(message: string, statusCode = 500) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

import { saveWhatsAppAccount } from "./whatsappOauth.service";

function metaResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("WhatsApp Coexistence onboarding safeguards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.encryptFacebookSecret.mockReturnValue("encrypted-token");
    mocks.registrationPin = undefined;
    mocks.accountFindFirst.mockResolvedValue(null);
    mocks.accountUpdate.mockResolvedValue({});
    mocks.accountUpsert.mockResolvedValue({
      id: 101,
      userId: 7,
      phoneNumberId: "phone-number-id",
      displayPhoneNumber: "+15551234567",
      wabaId: "waba-id",
      accessToken: "encrypted-token",
      connectionMode: "COEXISTENCE",
      businessProfileId: 42,
      coexistenceContactsSyncRequestedAt: null,
      coexistenceHistorySyncRequestedAt: null,
    });
  });

  it("skips /register and requests each one-time app-data sync for Coexistence", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(metaResponse({ is_on_biz_app: true, platform_type: "CLOUD_API" }))
      .mockResolvedValueOnce(metaResponse({ request_id: "contacts-request" }))
      .mockResolvedValueOnce(metaResponse({ request_id: "history-request" }));

    await saveWhatsAppAccount({
      userId: 7,
      wabaId: "waba-id",
      phoneNumberId: "phone-number-id",
      displayPhoneNumber: "+15551234567",
      accessToken: "plain-token",
      connectionMode: "COEXISTENCE",
      businessProfileId: 42,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("fields=is_on_biz_app,platform_type");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://graph.facebook.com/v25.0/phone-number-id/smb_app_data",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      messaging_product: "whatsapp",
      sync_type: "smb_app_state_sync",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      messaging_product: "whatsapp",
      sync_type: "history",
    });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/register"))).toBe(false);
    expect(mocks.accountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ coexistenceContactsSyncRequestedAt: expect.any(Date) }),
      }),
    );
    expect(mocks.accountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ coexistenceHistorySyncRequestedAt: expect.any(Date) }),
      }),
    );
  });

  it("continues the second sync when Meta rejects the first request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(metaResponse({ is_on_biz_app: true, platform_type: "CLOUD_API" }))
      .mockResolvedValueOnce(metaResponse({ error: { message: "temporary sync failure" } }, 500))
      .mockResolvedValueOnce(metaResponse({ request_id: "history-request" }));

    await saveWhatsAppAccount({
      userId: 7,
      wabaId: "waba-id",
      phoneNumberId: "phone-number-id",
      displayPhoneNumber: "+15551234567",
      accessToken: "plain-token",
      connectionMode: "COEXISTENCE",
      businessProfileId: 42,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      messaging_product: "whatsapp",
      sync_type: "history",
    });
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "whatsapp_oauth.coexistence_contacts_sync_failed",
      expect.objectContaining({ error: "temporary sync failure" }),
    );
    expect(mocks.accountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ coexistenceSyncLastError: expect.stringContaining("temporary sync failure") }),
      }),
    );
  });

  it("defers Coexistence synchronization when the saved account has no business profile", async () => {
    mocks.accountUpsert.mockResolvedValueOnce({
      id: 101,
      userId: 7,
      phoneNumberId: "phone-number-id",
      displayPhoneNumber: "+15551234567",
      wabaId: "waba-id",
      accessToken: "encrypted-token",
      connectionMode: "COEXISTENCE",
      businessProfileId: null,
      coexistenceContactsSyncRequestedAt: null,
      coexistenceHistorySyncRequestedAt: null,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(metaResponse({ is_on_biz_app: true, platform_type: "CLOUD_API" }));

    await saveWhatsAppAccount({
      userId: 7,
      wabaId: "waba-id",
      phoneNumberId: "phone-number-id",
      displayPhoneNumber: "+15551234567",
      accessToken: "plain-token",
      connectionMode: "COEXISTENCE",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/smb_app_data"))).toBe(false);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/register"))).toBe(false);
    expect(mocks.accountUpdate).not.toHaveBeenCalled();
  });

  it("starts deferred Coexistence synchronization on a later reconnect after profile linking", async () => {
    const unlinkedAccount = {
      id: 101,
      userId: 7,
      phoneNumberId: "phone-number-id",
      displayPhoneNumber: "+15551234567",
      wabaId: "waba-id",
      accessToken: "encrypted-token",
      connectionMode: "COEXISTENCE",
      businessProfileId: null,
      coexistenceContactsSyncRequestedAt: null,
      coexistenceHistorySyncRequestedAt: null,
    };
    const linkedAccount = { ...unlinkedAccount, businessProfileId: 42 };
    mocks.accountUpsert
      .mockReset()
      .mockResolvedValueOnce(unlinkedAccount)
      .mockResolvedValueOnce(linkedAccount);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(metaResponse({ is_on_biz_app: true, platform_type: "CLOUD_API" }))
      .mockResolvedValueOnce(metaResponse({ is_on_biz_app: true, platform_type: "CLOUD_API" }))
      .mockResolvedValueOnce(metaResponse({ request_id: "contacts-request" }))
      .mockResolvedValueOnce(metaResponse({ request_id: "history-request" }));

    const accountParams = {
      userId: 7,
      wabaId: "waba-id",
      phoneNumberId: "phone-number-id",
      displayPhoneNumber: "+15551234567",
      accessToken: "plain-token",
      connectionMode: "COEXISTENCE" as const,
    };
    await saveWhatsAppAccount(accountParams);
    await saveWhatsAppAccount({ ...accountParams, businessProfileId: 42 });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://graph.facebook.com/v25.0/phone-number-id/smb_app_data",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      messaging_product: "whatsapp",
      sync_type: "smb_app_state_sync",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      messaging_product: "whatsapp",
      sync_type: "history",
    });
  });

  it("treats already-requested Coexistence sync responses as idempotent success", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(metaResponse({ is_on_biz_app: true, platform_type: "CLOUD_API" }))
      .mockResolvedValueOnce(metaResponse({ error: { message: "sync already requested" } }, 400))
      .mockResolvedValueOnce(metaResponse({ error: { message: "requested only once" } }, 400));

    await saveWhatsAppAccount({
      userId: 7,
      wabaId: "waba-id",
      phoneNumberId: "phone-number-id",
      displayPhoneNumber: "+15551234567",
      accessToken: "plain-token",
      connectionMode: "COEXISTENCE",
      businessProfileId: 42,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "whatsapp_oauth.coexistence_sync_already_requested",
      expect.objectContaining({ syncType: "smb_app_state_sync" }),
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "whatsapp_oauth.coexistence_sync_already_requested",
      expect.objectContaining({ syncType: "history" }),
    );
    expect(mocks.accountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ coexistenceContactsSyncRequestedAt: expect.any(Date) }),
      }),
    );
    expect(mocks.accountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ coexistenceHistorySyncRequestedAt: expect.any(Date) }),
      }),
    );
  });

  it("skips standard automatic registration when no registration PIN is configured", async () => {
    mocks.accountUpsert.mockResolvedValueOnce({
      id: 101,
      userId: 7,
      phoneNumberId: "phone-number-id",
      displayPhoneNumber: "+15551234567",
      wabaId: "waba-id",
      accessToken: "encrypted-token",
      connectionMode: "BUSINESS_API",
      businessProfileId: null,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(metaResponse({ is_on_biz_app: false, platform_type: "CLOUD_API" }));

    await saveWhatsAppAccount({
      userId: 7,
      wabaId: "waba-id",
      phoneNumberId: "phone-number-id",
      displayPhoneNumber: "+15551234567",
      accessToken: "plain-token",
      connectionMode: "BUSINESS_API",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/register"))).toBe(false);
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "whatsapp_oauth.auto_registration_skipped",
      { phoneNumberId: "phone-number-id", reason: "registration_pin_not_configured" },
    );
    expect(JSON.stringify(mocks.loggerInfo.mock.calls)).not.toContain("plain-token");
  });

  it("uses the explicitly configured registration PIN for standard automatic registration", async () => {
    mocks.registrationPin = "654321";
    mocks.accountUpsert.mockResolvedValueOnce({
      id: 101,
      userId: 7,
      phoneNumberId: "phone-number-id",
      displayPhoneNumber: "+15551234567",
      wabaId: "waba-id",
      accessToken: "encrypted-token",
      connectionMode: "BUSINESS_API",
      businessProfileId: null,
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(metaResponse({ is_on_biz_app: false, platform_type: "CLOUD_API" }))
      .mockResolvedValueOnce(metaResponse({ success: true }));

    await saveWhatsAppAccount({
      userId: 7,
      wabaId: "waba-id",
      phoneNumberId: "phone-number-id",
      displayPhoneNumber: "+15551234567",
      accessToken: "plain-token",
      connectionMode: "BUSINESS_API",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://graph.facebook.com/v25.0/phone-number-id/register",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      messaging_product: "whatsapp",
      pin: "654321",
    });
    expect(JSON.stringify(mocks.loggerInfo.mock.calls)).not.toContain("654321");
  });
});
