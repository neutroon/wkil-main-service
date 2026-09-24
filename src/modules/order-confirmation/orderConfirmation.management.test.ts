import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import http from "http";
import express, { type Application } from "express";

vi.mock("@config/prisma", () => ({ default: {} }));
vi.mock("@config/env", () => ({ env: {} }));
vi.mock("@utils/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const mocks = vi.hoisted(() => ({
  getAccessibleProfileIds: vi.fn(),
  listOrderIntegrations: vi.fn(),
  findOrderIntegrationForProfiles: vi.fn(),
  createOrderIntegration: vi.fn(),
  updateOrderIntegration: vi.fn(),
  rotateOrderIntegrationSecret: vi.fn(),
  findWhatsAppAccountForProfile: vi.fn(),
  listOrderTemplateConfigs: vi.fn(),
  findOrderTemplateConfigByIdForProfiles: vi.fn(),
  findOrderTemplateConfigForTest: vi.fn(),
  createOrderTemplateConfig: vi.fn(),
  updateOrderTemplateConfig: vi.fn(),
  listManagedOrders: vi.fn(),
  findManagedOrder: vi.fn(),
  findNotificationForManagementRetry: vi.fn(),
  requeueNotificationForRetry: vi.fn(),
  findStoreSyncForManagementRetry: vi.fn(),
  requeueStoreSyncForRetry: vi.fn(),
  findSystemSettingUpdatedAt: vi.fn(),
  generateRandomToken: vi.fn(),
  encryptFacebookSecret: vi.fn(),
  decryptFacebookSecret: vi.fn(),
  listWhatsAppTemplates: vi.fn(),
  sendWhatsAppTemplate: vi.fn(),
  validateOrderTemplateMapping: vi.fn(),
  renderOrderTemplateVariables: vi.fn(),
  enqueueNotificationRetry: vi.fn(),
  enqueueStoreSyncRetry: vi.fn(),
  getSystemSetting: vi.fn(),
  updateSystemSetting: vi.fn(),
}));

vi.mock("@modules/auth/user/user.service", () => ({
  getAccessibleProfileIds: mocks.getAccessibleProfileIds,
}));

vi.mock("./orderConfirmation.repository", () => ({
  listOrderIntegrations: mocks.listOrderIntegrations,
  findOrderIntegrationForProfiles: mocks.findOrderIntegrationForProfiles,
  createOrderIntegration: mocks.createOrderIntegration,
  updateOrderIntegration: mocks.updateOrderIntegration,
  rotateOrderIntegrationSecret: mocks.rotateOrderIntegrationSecret,
  findWhatsAppAccountForProfile: mocks.findWhatsAppAccountForProfile,
  listOrderTemplateConfigs: mocks.listOrderTemplateConfigs,
  findOrderTemplateConfigByIdForProfiles: mocks.findOrderTemplateConfigByIdForProfiles,
  findOrderTemplateConfigForTest: mocks.findOrderTemplateConfigForTest,
  createOrderTemplateConfig: mocks.createOrderTemplateConfig,
  updateOrderTemplateConfig: mocks.updateOrderTemplateConfig,
  listManagedOrders: mocks.listManagedOrders,
  findManagedOrder: mocks.findManagedOrder,
  findNotificationForManagementRetry: mocks.findNotificationForManagementRetry,
  requeueNotificationForRetry: mocks.requeueNotificationForRetry,
  findStoreSyncForManagementRetry: mocks.findStoreSyncForManagementRetry,
  requeueStoreSyncForRetry: mocks.requeueStoreSyncForRetry,
  findSystemSettingUpdatedAt: mocks.findSystemSettingUpdatedAt,
}));

vi.mock("@modules/auth/core/tokenCrypto", () => ({
  generateRandomToken: mocks.generateRandomToken,
  encryptFacebookSecret: mocks.encryptFacebookSecret,
  decryptFacebookSecret: mocks.decryptFacebookSecret,
}));

vi.mock("@modules/meta/whatsapp/whatsapp.service", () => ({
  listWhatsAppTemplates: mocks.listWhatsAppTemplates,
  sendWhatsAppTemplate: mocks.sendWhatsAppTemplate,
}));

vi.mock("./orderConfirmation.template.service", async (importOriginal) => ({
  ...await importOriginal<typeof import("./orderConfirmation.template.service")>(),
  validateOrderTemplateMapping: mocks.validateOrderTemplateMapping,
  renderOrderTemplateVariables: mocks.renderOrderTemplateVariables,
}));

vi.mock("./orderConfirmation.queue", () => ({
  enqueueNotificationRetry: mocks.enqueueNotificationRetry,
  enqueueStoreSyncRetry: mocks.enqueueStoreSyncRetry,
}));

vi.mock("@modules/settings/settings.service", () => ({
  getSystemSetting: mocks.getSystemSetting,
  updateSystemSetting: mocks.updateSystemSetting,
}));

import orderConfirmationRoutes from "./orderConfirmation.routes";

type TestUser = {
  id: number;
  role: "user" | "admin";
  isEmailVerified: boolean;
};

function makeApp(user: TestUser = { id: 7, role: "user", isEmailVerified: true }): Application {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).user = user;
    next();
  });
  app.use(orderConfirmationRoutes);
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).json({ message: error.message });
  });
  return app;
}

function request(
  server: http.Server,
  options: { method: string; path: string; body?: unknown },
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const address = server.address() as { port: number };
    const body = options.body === undefined ? "" : JSON.stringify(options.body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: address.port,
        path: options.path,
        method: options.method,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const integrationWithSecrets = {
  id: 4,
  businessProfileId: 11,
  kind: "GENERIC",
  integrationKey: "public-key",
  signingSecret: "enc:signing",
  previousSigningSecret: "enc:previous",
  statusCallbackSecret: "enc:callback",
  previousStatusCallbackSecret: "enc:old-callback",
  statusCallbackUrl: "https://store.example.test/status",
  whatsappAccountId: 9,
  isActive: true,
  storeSyncEnabled: true,
  defaultLocale: "en",
  businessProfile: { id: 11, name: "Demo shop" },
  whatsappAccount: {
    id: 9,
    phoneNumberId: "phone-9",
    displayPhoneNumber: "+1 202 555 0100",
    wabaId: "waba-9",
    isActive: true,
  },
};

describe("order-confirmation management APIs", () => {
  let server: http.Server;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.getAccessibleProfileIds.mockResolvedValue([11]);
    mocks.listOrderIntegrations.mockResolvedValue([integrationWithSecrets]);
    mocks.findOrderIntegrationForProfiles.mockResolvedValue(integrationWithSecrets);
    mocks.generateRandomToken.mockReturnValue("plain-signing-secret");
    mocks.encryptFacebookSecret.mockImplementation((value: string) => `enc:${value}`);
    mocks.decryptFacebookSecret.mockImplementation((value: string) => value);
    mocks.createOrderIntegration.mockResolvedValue(integrationWithSecrets);
    mocks.createOrderTemplateConfig.mockResolvedValue({
      id: 22,
      businessProfileId: 11,
      whatsappAccountId: 9,
      eventType: "order.created",
      locale: "en",
      templateName: "order_confirm",
      languageCode: "en",
      templateVersion: 1,
      isActive: true,
      approvalStatus: "APPROVED",
      variableMapping: {
        body: ["orderNumber"],
        buttons: ["confirmToken", "cancelToken"],
      },
    });
    mocks.updateOrderIntegration.mockResolvedValue(integrationWithSecrets);
    mocks.rotateOrderIntegrationSecret.mockResolvedValue(integrationWithSecrets);
    mocks.findWhatsAppAccountForProfile.mockResolvedValue({
      id: 9,
      businessProfileId: 11,
      wabaId: "waba-9",
      accessToken: "enc:access",
      isActive: true,
    });
    mocks.validateOrderTemplateMapping.mockImplementation((mapping: unknown) => mapping);
    mocks.listWhatsAppTemplates.mockResolvedValue([
      {
        name: "order_confirm",
        language: "en",
        status: "APPROVED",
        components: [
          { type: "BODY", text: "Order {{1}}" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Confirm" },
              { type: "QUICK_REPLY", text: "Cancel" },
            ],
          },
        ],
      },
    ]);
    mocks.findOrderTemplateConfigForTest.mockResolvedValue({
      id: 21,
      businessProfileId: 11,
      whatsappAccountId: 9,
      eventType: "order.created",
      locale: "en",
      templateName: "order_confirm",
      languageCode: "en",
      templateVersion: 1,
      isActive: true,
      approvalStatus: "APPROVED",
      variableMapping: {
        body: ["orderNumber"],
        buttons: ["confirmToken", "cancelToken"],
      },
    });
    mocks.renderOrderTemplateVariables.mockReturnValue({
      body: ["#100"],
      buttons: { confirm: "preview-confirm", cancel: "preview-cancel" },
      previewText: "#100",
    });
    mocks.getSystemSetting.mockResolvedValue("true");
    mocks.findSystemSettingUpdatedAt.mockResolvedValue(new Date("2026-08-13T10:00:00.000Z"));
    mocks.updateSystemSetting.mockResolvedValue(undefined);
    server = http.createServer(makeApp());
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
  });

  afterEach(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  it("lists only accessible integrations and omits every stored secret", async () => {
    const response = await request(server, { method: "GET", path: "/order-integrations" });

    expect(response.status).toBe(200);
    expect(response.json.data[0]).toMatchObject({
      id: 4,
      businessProfileId: 11,
      integrationKey: "public-key",
      whatsappAccount: { id: 9, phoneNumberId: "phone-9" },
    });
    expect(JSON.stringify(response.json)).not.toContain("enc:signing");
    expect(JSON.stringify(response.json)).not.toContain("enc:callback");
    expect(response.json.data[0]).not.toHaveProperty("signingSecret");
    expect(response.json.data[0]).not.toHaveProperty("statusCallbackSecret");
    expect(mocks.listOrderIntegrations).toHaveBeenCalledWith({
      profileIds: [11],
      businessProfileId: undefined,
    });
  });

  it("returns the generated signing secret only from create", async () => {
    const response = await request(server, {
      method: "POST",
      path: "/order-integrations",
      body: { businessProfileId: 11, defaultLocale: "en" },
    });

    expect(response.status).toBe(201);
    expect(response.json.secret).toBe("plain-signing-secret");
    expect(response.json.data).not.toHaveProperty("signingSecret");
    expect(response.json.data).toHaveProperty("webhookUrl");
    expect(mocks.createOrderIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ signingSecret: "enc:plain-signing-secret" }),
    );
  });

  it("returns a rotated signing secret once and omits it from the public view", async () => {
    const response = await request(server, {
      method: "POST",
      path: "/order-integrations/4/rotate-secret",
    });

    expect(response.status).toBe(200);
    expect(response.json.secret).toBe("plain-signing-secret");
    expect(response.json.data).not.toHaveProperty("signingSecret");
    expect(response.json.data).not.toHaveProperty("previousSigningSecret");
    expect(JSON.stringify(response.json)).not.toContain("enc:signing");
  });

  it("denies an integration that is outside the accessible profile boundary", async () => {
    mocks.findOrderIntegrationForProfiles.mockResolvedValue(null);

    const response = await request(server, {
      method: "PATCH",
      path: "/order-integrations/99",
      body: { isActive: true },
    });

    expect(response.status).toBe(404);
    expect(mocks.updateOrderIntegration).not.toHaveBeenCalled();
  });

  it("rejects non-HTTPS callbacks and missing callback secrets when sync is enabled", async () => {
    const insecure = await request(server, {
      method: "POST",
      path: "/order-integrations",
      body: {
        businessProfileId: 11,
        storeSyncEnabled: true,
        statusCallbackUrl: "http://store.example.test/status",
        statusCallbackSecret: "callback-secret",
      },
    });
    expect(insecure.status).toBe(400);

    const missingSecret = await request(server, {
      method: "POST",
      path: "/order-integrations",
      body: {
        businessProfileId: 11,
        storeSyncEnabled: true,
        statusCallbackUrl: "https://store.example.test/status",
      },
    });
    expect(missingSecret.status).toBe(400);
    expect(mocks.createOrderIntegration).not.toHaveBeenCalled();
  });

  it("revalidates an existing callback URL when synchronization is enabled", async () => {
    mocks.findOrderIntegrationForProfiles.mockResolvedValue({
      ...integrationWithSecrets,
      statusCallbackUrl: "http://store.example.test/status",
      storeSyncEnabled: false,
    });

    const response = await request(server, {
      method: "PATCH",
      path: "/order-integrations/4",
      body: { storeSyncEnabled: true },
    });

    expect(response.status).toBe(400);
    expect(mocks.updateOrderIntegration).not.toHaveBeenCalled();
  });

  it("rejects unknown template fields before activation", async () => {
    mocks.validateOrderTemplateMapping.mockImplementation(() => {
      throw new Error("Unknown body field: customer.email");
    });

    const response = await request(server, {
      method: "POST",
      path: "/order-confirmations/template-configs",
      body: {
        integrationId: 4,
        businessProfileId: 11,
        whatsappAccountId: 9,
        eventType: "order.created",
        locale: "en",
        templateName: "order_confirm",
        languageCode: "en",
        variableMapping: {
          body: ["customer.email"],
          buttons: ["confirmToken", "cancelToken"],
        },
        isActive: true,
      },
    });

    expect(response.status).toBe(400);
    expect(mocks.createOrderTemplateConfig).not.toHaveBeenCalled();
    expect(mocks.listWhatsAppTemplates).not.toHaveBeenCalled();
  });

  it("rejects a template account that is not the integration's configured account", async () => {
    mocks.findWhatsAppAccountForProfile.mockResolvedValue({
      id: 10,
      businessProfileId: 11,
      wabaId: "waba-10",
      accessToken: "access-10",
      isActive: true,
    });

    const response = await request(server, {
      method: "POST",
      path: "/order-confirmations/template-configs",
      body: {
        integrationId: 4,
        businessProfileId: 11,
        whatsappAccountId: 10,
        eventType: "order.created",
        locale: "en",
        templateName: "order_confirm",
        languageCode: "en",
        variableMapping: {
          body: ["orderNumber"],
          buttons: ["confirmToken", "cancelToken"],
        },
        isActive: true,
      },
    });

    expect(response.status).toBe(400);
    expect(mocks.createOrderTemplateConfig).not.toHaveBeenCalled();
  });

  it("accepts an approved notification-only template without button mappings", async () => {
    mocks.listWhatsAppTemplates.mockResolvedValue([{
      name: "order_notice", language: "en", status: "APPROVED",
      components: [{ type: "BODY", text: "Order {{1}}" }],
    }]);
    const response = await request(server, {
      method: "POST", path: "/order-confirmations/template-configs",
      body: { integrationId: 4, businessProfileId: 11, whatsappAccountId: 9,
        eventType: "order.created", locale: "en", templateName: "order_notice",
        languageCode: "en", variableMapping: { body: ["orderNumber"] }, isActive: true },
    });
    expect(response.status).toBe(201);
    expect(mocks.createOrderTemplateConfig).toHaveBeenCalledWith(expect.objectContaining({
      variableMapping: { body: ["orderNumber"] },
    }));
  });

  it("rejects action mappings attached to a notification-only template", async () => {
    mocks.listWhatsAppTemplates.mockResolvedValue([{
      name: "order_notice", language: "en", status: "APPROVED",
      components: [{ type: "BODY", text: "Order {{1}}" }],
    }]);
    const response = await request(server, {
      method: "POST", path: "/order-confirmations/template-configs",
      body: { integrationId: 4, whatsappAccountId: 9, eventType: "order.created", locale: "en",
        templateName: "order_notice", languageCode: "en",
        variableMapping: { body: ["orderNumber"], buttons: ["confirmToken", "cancelToken"] } },
    });
    expect(response.status).toBe(400);
    expect(mocks.createOrderTemplateConfig).not.toHaveBeenCalled();
  });

  it("accepts localized quick-reply labels because action mapping follows button position", async () => {
    mocks.listWhatsAppTemplates.mockResolvedValue([
      {
        name: "order_confirm",
        language: "ar",
        status: "APPROVED",
        components: [
          { type: "BODY", text: "Order {{1}}" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "تأكيد" },
              { type: "QUICK_REPLY", text: "إلغاء" },
            ],
          },
        ],
      },
    ]);

    const response = await request(server, {
      method: "POST",
      path: "/order-confirmations/template-configs",
      body: {
        integrationId: 4,
        businessProfileId: 11,
        whatsappAccountId: 9,
        eventType: "order.created",
        locale: "ar",
        templateName: "order_confirm",
        languageCode: "ar",
        variableMapping: {
          body: ["orderNumber"],
          buttons: ["confirmToken", "cancelToken"],
        },
        isActive: true,
      },
    });

    expect(response.status).toBe(201);
    expect(mocks.createOrderTemplateConfig).toHaveBeenCalled();
  });

  it("rejects listing template configs for an account different from the integration account", async () => {
    mocks.findWhatsAppAccountForProfile.mockResolvedValue({
      id: 10,
      businessProfileId: 11,
      wabaId: "waba-10",
      accessToken: "access-10",
      isActive: true,
    });
    mocks.listOrderTemplateConfigs.mockResolvedValue([]);

    const response = await request(server, {
      method: "GET",
      path: "/order-confirmations/template-configs?integrationId=4&whatsappAccountId=10",
    });

    expect(response.status).toBe(400);
    expect(mocks.listOrderTemplateConfigs).not.toHaveBeenCalled();
  });

  it("renders a test preview without contacting a customer", async () => {
    const response = await request(server, {
      method: "POST",
      path: "/order-integrations/4/test-event",
      body: {
        schemaVersion: "1",
        eventId: "evt-test",
        eventType: "order.created",
        occurredAt: "2026-08-13T10:30:00.000Z",
        order: {
          id: "order-test",
          number: "#100",
          currency: "USD",
          total: "10.00",
          customer: { phone: "+12025550123" },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.json.data.previewText).toBe("#100");
    expect(mocks.sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(mocks.enqueueNotificationRetry).not.toHaveBeenCalled();
  });

  it("accepts top-level preview locale and templateConfigId without passing them to canonical parsing", async () => {
    const response = await request(server, {
      method: "POST",
      path: "/order-integrations/4/test-event",
      body: {
        schemaVersion: "1",
        eventId: "evt-test-options",
        eventType: "order.created",
        occurredAt: "2026-08-13T10:30:00.000Z",
        locale: "ar",
        templateConfigId: 21,
        order: {
          id: "order-test-options",
          number: "#101",
          currency: "USD",
          total: "11.00",
          customer: { phone: "+12025550123" },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.json.data.locale).toBe("ar");
    expect(mocks.findOrderTemplateConfigForTest).toHaveBeenCalledWith(
      expect.objectContaining({ id: 21, locale: "ar" }),
    );
    expect(mocks.sendWhatsAppTemplate).not.toHaveBeenCalled();
  });

  it("rejects updates for a template config without an integration context", async () => {
    mocks.findOrderTemplateConfigByIdForProfiles.mockResolvedValue({
      id: 21,
      businessProfileId: 11,
      whatsappAccountId: 9,
      eventType: "order.created",
      locale: "en",
      templateName: "order_confirm",
      languageCode: "en",
      templateVersion: 1,
      isActive: true,
      approvalStatus: "APPROVED",
      variableMapping: {
        body: ["orderNumber"],
        buttons: ["confirmToken", "cancelToken"],
      },
    });

    const response = await request(server, {
      method: "PATCH",
      path: "/order-confirmations/template-configs/21",
      body: { whatsappAccountId: 9, isActive: false },
    });

    expect(response.status).toBe(400);
    expect(mocks.updateOrderTemplateConfig).not.toHaveBeenCalled();
  });

  it("passes pagination and status filters and keeps order views free of payloads and action tokens", async () => {
    mocks.listManagedOrders.mockResolvedValue({
      data: [
        {
          id: 31,
          status: "AWAITING_CONFIRMATION",
          sourceEventId: "evt-31",
          notifications: [{
            id: 41,
            status: "FAILED",
            lastError: "provider unavailable",
            summaryMode: "NOTIFICATION_ONLY",
          }],
          storeSyncs: [],
          rawPayload: { customerPhone: "+12025550123" },
          actionTokens: [{ tokenHash: "hash-only" }],
        },
      ],
      meta: { total: 1, page: 2, limit: 10, totalPages: 1 },
    });

    const response = await request(server, {
      method: "GET",
      path: "/order-confirmations/orders?page=2&limit=10&status=AWAITING_CONFIRMATION",
    });

    expect(response.status).toBe(200);
    expect(mocks.listManagedOrders).toHaveBeenCalledWith(
      expect.objectContaining({ profileIds: [11], page: 2, limit: 10, status: "AWAITING_CONFIRMATION" }),
    );
    expect(JSON.stringify(response.json)).not.toContain("rawPayload");
    expect(JSON.stringify(response.json)).not.toContain("hash-only");
    expect(response.json.data[0].notifications[0].mode).toBe("NOTIFICATION_ONLY");
    expect(response.json.data[0].notifications[0]).not.toHaveProperty("renderedVariables");
    expect(response.json.data[0].notifications[0]).not.toHaveProperty("summaryMode");
  });

  it("forwards trimmed order search within the selected profile and returns the full phone number", async () => {
    mocks.listManagedOrders.mockResolvedValue({
      data: [{
        id: 31,
        businessProfileId: 11,
        integrationId: 4,
        externalOrderId: "order-31",
        orderNumber: "#31",
        status: "AWAITING_CONFIRMATION",
        customerPhone: "+201005550184",
        customerName: "Nadia",
        locale: "en",
        total: "42.50",
        currency: "EGP",
        events: [{ externalEventId: "evt-31" }],
        notifications: [],
        storeSyncs: [],
      }],
      meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
    });

    const response = await request(server, {
      method: "GET",
      path: "/order-confirmations/orders?businessProfileId=11&search=%2B20%20100&page=1&limit=20",
    });

    expect(response.status).toBe(200);
    expect(mocks.listManagedOrders).toHaveBeenCalledWith({
      profileIds: [11],
      businessProfileId: 11,
      integrationId: undefined,
      status: undefined,
      search: "+20 100",
      page: 1,
      limit: 20,
    });
    expect(response.json.data[0].customerPhone).toBe("+201005550184");
  });

  it("rejects order search longer than 120 characters before repository access", async () => {
    const search = "a".repeat(121);
    const response = await request(server, {
      method: "GET",
      path: `/order-confirmations/orders?search=${encodeURIComponent(search)}`,
    });

    expect(response.status).toBe(400);
    expect(response.json.message).toContain("Too big");
    expect(mocks.listManagedOrders).not.toHaveBeenCalled();
  });

  it("does not query orders for an inaccessible profile", async () => {
    const response = await request(server, {
      method: "GET",
      path: "/order-confirmations/orders?businessProfileId=12",
    });

    expect(response.status).toBe(404);
    expect(mocks.listManagedOrders).not.toHaveBeenCalled();
  });

  it("returns complete normalized order details without infrastructure secrets or action tokens", async () => {
    const lineItems = [{ id: "line-1", name: "Notebook", quantity: 2, unitPrice: "12.50", total: "25.00" }];
    const shippingAddress = {
      addressLine1: "10 Nile St",
      city: "Cairo",
      state: "Cairo Governorate",
      postalCode: "11511",
      country: "EG",
    };
    const metadata = { source: "shop-platform", campaign: "summer", flags: { gift: false } };
    mocks.findManagedOrder.mockResolvedValue({
      id: 31,
      businessProfileId: 11,
      integrationId: 4,
      externalOrderId: "external-31",
      orderNumber: "#31",
      status: "CONFIRMED",
      customerPhone: "+201005550184",
      customerName: "Nadia",
      locale: "ar",
      total: "25.00",
      currency: "EGP",
      lineItems,
      shippingAddress,
      metadata,
      sourceStatus: "paid",
      paymentMethod: "card",
      sourceCreatedAt: new Date("2026-08-13T09:00:00.000Z"),
      sourceUpdatedAt: new Date("2026-08-13T09:30:00.000Z"),
      createdAt: new Date("2026-08-13T09:00:01.000Z"),
      updatedAt: new Date("2026-08-13T09:31:00.000Z"),
      events: [
        {
          id: 61,
          externalEventId: "evt-31",
          eventType: "order.updated",
          schemaVersion: "2",
          status: "PROCESSED",
          attemptCount: 1,
          lastError: null,
          occurredAt: new Date("2026-08-13T09:30:00.000Z"),
          receivedAt: new Date("2026-08-13T09:30:01.000Z"),
          processedAt: new Date("2026-08-13T09:30:02.000Z"),
          createdAt: new Date("2026-08-13T09:30:01.000Z"),
          updatedAt: new Date("2026-08-13T09:30:02.000Z"),
          rawPayload: { "private-payload": true },
        },
        {
          id: 60,
          externalEventId: "evt-30",
          eventType: "order.created",
          schemaVersion: "1",
          status: "PROCESSED",
          attemptCount: 1,
          lastError: null,
          occurredAt: new Date("2026-08-13T09:00:00.000Z"),
          receivedAt: new Date("2026-08-13T09:00:01.000Z"),
          processedAt: null,
          createdAt: new Date("2026-08-13T09:00:01.000Z"),
          updatedAt: new Date("2026-08-13T09:00:02.000Z"),
          rawPayload: { "private-payload": true },
        },
      ],
      notifications: [
        {
          id: 41,
          kind: "CONFIRMATION_REQUEST",
          renderedVariables: {
            body: ["Order #31"],
            previewText: "Order #31",
            buttonMapping: ["confirmToken", "cancelToken"],
            mode: "CONFIRMATION",
          },
          status: "FAILED",
          providerMessageId: "wamid-41",
          conversationMessageId: 88,
          attemptCount: 2,
          lastError: "provider unavailable",
          queuedAt: new Date("2026-08-13T09:01:00.000Z"),
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          failedAt: new Date("2026-08-13T09:02:00.000Z"),
          createdAt: new Date("2026-08-13T09:01:00.000Z"),
          updatedAt: new Date("2026-08-13T09:02:00.000Z"),
        },
        {
          id: 42,
          kind: "ACKNOWLEDGEMENT",
          renderedVariables: { action: "CONFIRM" },
          status: "SENT",
          providerMessageId: "wamid-42",
          conversationMessageId: null,
          attemptCount: 1,
          lastError: null,
          queuedAt: new Date("2026-08-13T09:03:00.000Z"),
          sentAt: new Date("2026-08-13T09:03:30.000Z"),
          deliveredAt: null,
          readAt: null,
          failedAt: null,
          createdAt: new Date("2026-08-13T09:03:00.000Z"),
          updatedAt: new Date("2026-08-13T09:03:30.000Z"),
        },
      ],
      storeSyncs: [
        {
          id: 51,
          requestedStatus: "CONFIRMED",
          status: "FAILED",
          providerStatus: "ERROR",
          attemptCount: 2,
          lastError: "store unavailable",
          nextAttemptAt: null,
          startedAt: new Date("2026-08-13T09:04:00.000Z"),
          completedAt: null,
          failedAt: new Date("2026-08-13T09:05:00.000Z"),
          createdAt: new Date("2026-08-13T09:04:00.000Z"),
          updatedAt: new Date("2026-08-13T09:05:00.000Z"),
        },
        {
          id: 52,
          requestedStatus: "CANCELED",
          status: "SUCCEEDED",
          providerStatus: "cancelled",
          attemptCount: 1,
          lastError: null,
          nextAttemptAt: null,
          startedAt: new Date("2026-08-13T09:06:00.000Z"),
          completedAt: new Date("2026-08-13T09:06:30.000Z"),
          failedAt: null,
          createdAt: new Date("2026-08-13T09:06:00.000Z"),
          updatedAt: new Date("2026-08-13T09:06:30.000Z"),
        },
      ],
      rawPayload: { "private-payload": true },
      actionTokens: [{ token: "private-action-token", tokenHash: "private-token-hash" }],
      signingSecret: "private-signing-secret",
      callbackSecret: "private-callback-secret",
      accessToken: "private-access-token",
    });

    const response = await request(server, {
      method: "GET",
      path: "/order-confirmations/orders/31",
    });

    expect(response.status).toBe(200);
    expect(response.json.data).toEqual({
      id: 31,
      businessProfileId: 11,
      integrationId: 4,
      externalOrderId: "external-31",
      orderNumber: "#31",
      status: "CONFIRMED",
      customerPhone: "+201005550184",
      customerName: "Nadia",
      locale: "ar",
      total: "25.00",
      currency: "EGP",
      lineItems,
      shippingAddress,
      sourceStatus: "paid",
      paymentMethod: "card",
      metadata,
      sourceEventId: "evt-31",
      events: [
        {
          id: 61,
          externalEventId: "evt-31",
          eventType: "order.updated",
          schemaVersion: "2",
          status: "PROCESSED",
          attemptCount: 1,
          lastError: null,
          occurredAt: "2026-08-13T09:30:00.000Z",
          receivedAt: "2026-08-13T09:30:01.000Z",
          processedAt: "2026-08-13T09:30:02.000Z",
          createdAt: "2026-08-13T09:30:01.000Z",
          updatedAt: "2026-08-13T09:30:02.000Z",
        },
        {
          id: 60,
          externalEventId: "evt-30",
          eventType: "order.created",
          schemaVersion: "1",
          status: "PROCESSED",
          attemptCount: 1,
          lastError: null,
          occurredAt: "2026-08-13T09:00:00.000Z",
          receivedAt: "2026-08-13T09:00:01.000Z",
          processedAt: null,
          createdAt: "2026-08-13T09:00:01.000Z",
          updatedAt: "2026-08-13T09:00:02.000Z",
        },
      ],
      notification: {
        mode: "CONFIRMATION",
        id: 41,
        kind: "CONFIRMATION_REQUEST",
        status: "FAILED",
        providerMessageId: "wamid-41",
        conversationMessageId: 88,
        attemptCount: 2,
        lastError: "provider unavailable",
        queuedAt: "2026-08-13T09:01:00.000Z",
        sentAt: null,
        deliveredAt: null,
        readAt: null,
        failedAt: "2026-08-13T09:02:00.000Z",
        createdAt: "2026-08-13T09:01:00.000Z",
        updatedAt: "2026-08-13T09:02:00.000Z",
        renderedVariables: {
          body: ["Order #31"],
          previewText: "Order #31",
          buttonMapping: ["confirmToken", "cancelToken"],
          mode: "CONFIRMATION",
        },
      },
      notifications: [
        {
          mode: "CONFIRMATION",
          id: 41,
          kind: "CONFIRMATION_REQUEST",
          status: "FAILED",
          providerMessageId: "wamid-41",
          conversationMessageId: 88,
          attemptCount: 2,
          lastError: "provider unavailable",
          queuedAt: "2026-08-13T09:01:00.000Z",
          sentAt: null,
          deliveredAt: null,
          readAt: null,
          failedAt: "2026-08-13T09:02:00.000Z",
          createdAt: "2026-08-13T09:01:00.000Z",
          updatedAt: "2026-08-13T09:02:00.000Z",
          renderedVariables: {
            body: ["Order #31"],
            previewText: "Order #31",
            buttonMapping: ["confirmToken", "cancelToken"],
            mode: "CONFIRMATION",
          },
        },
        {
          mode: "CONFIRMATION",
          id: 42,
          kind: "ACKNOWLEDGEMENT",
          status: "SENT",
          providerMessageId: "wamid-42",
          conversationMessageId: null,
          attemptCount: 1,
          lastError: null,
          queuedAt: "2026-08-13T09:03:00.000Z",
          sentAt: "2026-08-13T09:03:30.000Z",
          deliveredAt: null,
          readAt: null,
          failedAt: null,
          createdAt: "2026-08-13T09:03:00.000Z",
          updatedAt: "2026-08-13T09:03:30.000Z",
          renderedVariables: { action: "CONFIRM" },
        },
      ],
      storeSync: {
        id: 51,
        requestedStatus: "CONFIRMED",
        status: "FAILED",
        providerStatus: "ERROR",
        attemptCount: 2,
        lastError: "store unavailable",
        nextAttemptAt: null,
        startedAt: "2026-08-13T09:04:00.000Z",
        completedAt: null,
        failedAt: "2026-08-13T09:05:00.000Z",
        createdAt: "2026-08-13T09:04:00.000Z",
        updatedAt: "2026-08-13T09:05:00.000Z",
      },
      storeSyncs: [
        {
          id: 51,
          requestedStatus: "CONFIRMED",
          status: "FAILED",
          providerStatus: "ERROR",
          attemptCount: 2,
          lastError: "store unavailable",
          nextAttemptAt: null,
          startedAt: "2026-08-13T09:04:00.000Z",
          completedAt: null,
          failedAt: "2026-08-13T09:05:00.000Z",
          createdAt: "2026-08-13T09:04:00.000Z",
          updatedAt: "2026-08-13T09:05:00.000Z",
        },
        {
          id: 52,
          requestedStatus: "CANCELED",
          status: "SUCCEEDED",
          providerStatus: "cancelled",
          attemptCount: 1,
          lastError: null,
          nextAttemptAt: null,
          startedAt: "2026-08-13T09:06:00.000Z",
          completedAt: "2026-08-13T09:06:30.000Z",
          failedAt: null,
          createdAt: "2026-08-13T09:06:00.000Z",
          updatedAt: "2026-08-13T09:06:30.000Z",
        },
      ],
      sourceCreatedAt: "2026-08-13T09:00:00.000Z",
      sourceUpdatedAt: "2026-08-13T09:30:00.000Z",
      createdAt: "2026-08-13T09:00:01.000Z",
      updatedAt: "2026-08-13T09:31:00.000Z",
    });
    const serialized = JSON.stringify(response.json);
    expect(serialized).not.toContain("private-payload");
    expect(serialized).not.toContain("private-action-token");
    expect(serialized).not.toContain("private-token-hash");
    expect(serialized).not.toContain("private-signing-secret");
    expect(serialized).not.toContain("private-callback-secret");
    expect(serialized).not.toContain("private-access-token");
  });

  it("does not retry a notification belonging to another profile", async () => {
    mocks.findNotificationForManagementRetry.mockResolvedValue(null);

    const response = await request(server, {
      method: "POST",
      path: "/order-confirmations/notifications/41/retry",
    });

    expect(response.status).toBe(404);
    expect(mocks.requeueNotificationForRetry).not.toHaveBeenCalled();
    expect(mocks.enqueueNotificationRetry).not.toHaveBeenCalled();
  });

  it("requeues the existing failed notification without creating another workflow", async () => {
    mocks.findNotificationForManagementRetry.mockResolvedValue({
      id: 41,
      businessProfileId: 11,
      kind: "CONFIRMATION_REQUEST",
      status: "FAILED",
      order: { id: 31, businessProfileId: 11, status: "AWAITING_CONFIRMATION" },
    });
    mocks.requeueNotificationForRetry.mockResolvedValue(true);
    mocks.enqueueNotificationRetry.mockResolvedValue(undefined);

    const response = await request(server, {
      method: "POST",
      path: "/order-confirmations/notifications/41/retry",
    });

    expect(response.status).toBe(202);
    expect(mocks.requeueNotificationForRetry).toHaveBeenCalledWith(41, 11);
    expect(mocks.enqueueNotificationRetry).toHaveBeenCalledWith(
      41,
      "management-notification-retry-41",
    );
    expect(mocks.createOrderTemplateConfig).not.toHaveBeenCalled();
  });

  it("exposes only the boolean global state and timestamp to admins", async () => {
    const adminServer = http.createServer(
      makeApp({ id: 8, role: "admin", isEmailVerified: true }),
    );
    await new Promise<void>((resolve, reject) => {
      adminServer.once("error", reject);
      adminServer.listen(0, "127.0.0.1", resolve);
    });

    const response = await request(adminServer, {
      method: "GET",
      path: "/order-confirmations/global-state",
    });
    await new Promise<void>((resolve, reject) => {
      adminServer.close((error) => (error ? reject(error) : resolve()));
    });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      data: {
        enabled: true,
        updatedAt: "2026-08-13T10:00:00.000Z",
      },
    });
    expect(response.json.data).not.toHaveProperty("key");
    expect(response.json.data).not.toHaveProperty("value");
  });
});
