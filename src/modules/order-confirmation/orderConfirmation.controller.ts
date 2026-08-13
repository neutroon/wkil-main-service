import type { Request, Response } from "express";
import type { AuthRequest } from "@modules/auth/core/auth.middleware";
import { getAccessibleProfileIds } from "@modules/auth/user/user.service";
import { AppError } from "@middlewares/errorHandler.middleware";
import {
  decryptFacebookSecret,
  encryptFacebookSecret,
  generateRandomToken,
} from "@modules/auth/core/tokenCrypto";
import { listWhatsAppTemplates } from "@modules/meta/whatsapp/whatsapp.service";
import { getSystemSetting, updateSystemSetting } from "@modules/settings/settings.service";
import {
  createOrderIntegration,
  createOrderTemplateConfig,
  findManagedOrder,
  findNotificationForManagementRetry,
  findOrderIntegrationForProfiles,
  findOrderTemplateConfigByIdForProfiles,
  findOrderTemplateConfigForTest,
  findStoreSyncForManagementRetry,
  findSystemSettingUpdatedAt,
  findWhatsAppAccountForProfile,
  listManagedOrders,
  listOrderIntegrations,
  listOrderTemplateConfigs,
  requeueNotificationForRetry,
  requeueStoreSyncForRetry,
  rotateOrderIntegrationSecret,
  updateOrderIntegration,
  updateOrderTemplateConfig,
  type OrderIntegrationManagementRecord,
  type OrderTemplateConfigManagementRecord,
} from "./orderConfirmation.repository";
import {
  enqueueNotificationRetry,
  enqueueStoreSyncRetry,
} from "./orderConfirmation.queue";
import {
  renderOrderTemplateVariables,
  validateOrderTemplateMapping,
  type OrderTemplateMapping,
} from "./orderConfirmation.template.service";
import { normalizeCanonicalOrderEvent } from "./orderConfirmation.normalizer";

const GLOBAL_SETTING_KEY = "order_confirmations_global_enabled";
const DEFAULT_EVENT_TYPE = "order.created";

type ProfileScopedRequest = Request & { user?: AuthRequest["user"] };

function currentUserId(req: ProfileScopedRequest): number {
  const userId = req.user?.id;
  if (!userId) throw new AppError("Unauthorized", 401, true, "UNAUTHORIZED");
  return userId;
}

async function accessibleProfiles(req: ProfileScopedRequest): Promise<number[]> {
  return getAccessibleProfileIds(currentUserId(req));
}

function requireAccessibleProfile(profileIds: number[], businessProfileId: number): void {
  if (!profileIds.includes(businessProfileId)) {
    throw new AppError("Business profile not found", 404, true, "PROFILE_NOT_FOUND");
  }
}

function notFound(message: string): never {
  throw new AppError(message, 404, true, "ORDER_CONFIRMATION_NOT_FOUND");
}

function badRequest(message: string, code = "ORDER_CONFIRMATION_VALIDATION_FAILED"): never {
  throw new AppError(message, 400, true, code);
}

function conflict(message: string): never {
  throw new AppError(message, 409, true, "ORDER_CONFIRMATION_CONFLICT");
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function oneTimeEncryptedSecret(secret: string): string {
  const encrypted = encryptFacebookSecret(secret);
  if (encrypted === secret) {
    throw new AppError(
      "Order-confirmation secret encryption is not configured",
      500,
      true,
      "ORDER_CONFIRMATION_SECRET_ENCRYPTION_UNAVAILABLE",
    );
  }
  return encrypted;
}

function parseHttpsCallbackUrl(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    badRequest("Status callback URL is required when provided");
  }

  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    badRequest("Invalid status callback URL");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.hostname.length === 0 ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hash.length > 0
  ) {
    badRequest("Status callback URL must be an HTTPS URL without credentials or fragments");
  }

  return parsed.toString();
}

function nonBlankSecret(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0) {
    badRequest("Status callback secret must not be blank");
  }
  return value.trim();
}

function baseUrl(req: Request): string {
  const configured = process.env.BACKEND_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  return `${req.protocol}://${req.get("host") || "localhost"}`;
}

function webhookUrl(req: Request, integrationKey: string): string {
  return `${baseUrl(req)}/v1/order-integrations/${encodeURIComponent(integrationKey)}/events`;
}

function publicAccount(account: any): Record<string, unknown> | null {
  if (!account) return null;
  return {
    id: account.id,
    phoneNumberId: account.phoneNumberId,
    displayPhoneNumber: account.displayPhoneNumber,
    wabaId: account.wabaId,
    isActive: account.isActive,
  };
}

function serializeIntegration(record: any, req?: Request): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: record.id,
    businessProfileId: record.businessProfileId,
    kind: record.kind,
    integrationKey: record.integrationKey,
    statusCallbackUrl: record.statusCallbackUrl ?? null,
    isActive: record.isActive,
    storeSyncEnabled: record.storeSyncEnabled,
    defaultLocale: record.defaultLocale,
    createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : record.updatedAt,
    businessProfile: record.businessProfile
      ? { id: record.businessProfile.id, name: record.businessProfile.name }
      : undefined,
    whatsappAccountId: record.whatsappAccountId ?? null,
    whatsappAccount: publicAccount(record.whatsappAccount),
  };

  if (req) result.webhookUrl = webhookUrl(req, record.integrationKey);
  return result;
}

function serializeTemplateConfig(record: any): Record<string, unknown> {
  return {
    id: record.id,
    businessProfileId: record.businessProfileId,
    whatsappAccountId: record.whatsappAccountId,
    eventType: record.eventType,
    locale: record.locale,
    templateName: record.templateName,
    languageCode: record.languageCode,
    templateVersion: record.templateVersion,
    isActive: record.isActive,
    approvalStatus: record.approvalStatus,
    variableMapping: record.variableMapping,
    lastSyncedAt:
      record.lastSyncedAt instanceof Date ? record.lastSyncedAt.toISOString() : record.lastSyncedAt,
    createdAt: record.createdAt instanceof Date ? record.createdAt.toISOString() : record.createdAt,
    updatedAt: record.updatedAt instanceof Date ? record.updatedAt.toISOString() : record.updatedAt,
  };
}

function serializeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function maskPhone(phone: unknown): string | null {
  if (typeof phone !== "string" || phone.length === 0) return null;
  if (phone.length <= 5) return "***";
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}

function serializeNotification(notification: any): Record<string, unknown> {
  return {
    id: notification.id,
    kind: notification.kind,
    status: notification.status,
    providerMessageId: notification.providerMessageId ?? null,
    conversationMessageId: notification.conversationMessageId ?? null,
    attemptCount: notification.attemptCount,
    lastError: notification.lastError ?? null,
    queuedAt: serializeDate(notification.queuedAt),
    sentAt: serializeDate(notification.sentAt),
    deliveredAt: serializeDate(notification.deliveredAt),
    readAt: serializeDate(notification.readAt),
    failedAt: serializeDate(notification.failedAt),
    createdAt: serializeDate(notification.createdAt),
    updatedAt: serializeDate(notification.updatedAt),
  };
}

function serializeStoreSync(sync: any): Record<string, unknown> {
  return {
    id: sync.id,
    requestedStatus: sync.requestedStatus,
    status: sync.status,
    providerStatus: sync.providerStatus ?? null,
    attemptCount: sync.attemptCount,
    lastError: sync.lastError ?? null,
    nextAttemptAt: serializeDate(sync.nextAttemptAt),
    startedAt: serializeDate(sync.startedAt),
    completedAt: serializeDate(sync.completedAt),
    failedAt: serializeDate(sync.failedAt),
    createdAt: serializeDate(sync.createdAt),
    updatedAt: serializeDate(sync.updatedAt),
  };
}

function serializeOrder(order: any): Record<string, unknown> {
  const notifications = Array.isArray(order.notifications)
    ? order.notifications.map(serializeNotification)
    : [];
  const storeSyncs = Array.isArray(order.storeSyncs) ? order.storeSyncs.map(serializeStoreSync) : [];
  const confirmation = notifications.find((notification: any) => notification.kind === "CONFIRMATION_REQUEST") ?? null;

  return {
    id: order.id,
    businessProfileId: order.businessProfileId,
    integrationId: order.integrationId,
    externalOrderId: order.externalOrderId,
    orderNumber: order.orderNumber,
    status: order.status,
    customerPhone: maskPhone(order.customerPhone),
    customerName: order.customerName ?? null,
    locale: order.locale,
    total: order.total === null || order.total === undefined ? null : String(order.total),
    currency: order.currency,
    sourceEventId: order.events?.[0]?.externalEventId ?? null,
    notification: confirmation,
    notifications,
    storeSync: storeSyncs[0] ?? null,
    storeSyncs,
    sourceCreatedAt: serializeDate(order.sourceCreatedAt),
    sourceUpdatedAt: serializeDate(order.sourceUpdatedAt),
    createdAt: serializeDate(order.createdAt),
    updatedAt: serializeDate(order.updatedAt),
  };
}

function templateLanguage(template: any): string {
  const value = template.languageCode ?? template.language ?? template.language_code ?? "";
  if (typeof value === "object" && value !== null) {
    return String((value as { code?: unknown }).code ?? "");
  }
  return String(value);
}

function templateStatus(template: any): string {
  return String(template.status ?? "").toUpperCase();
}

function templateComponents(template: any): any[] {
  return Array.isArray(template.components) ? template.components : [];
}

function hasRequiredQuickReplies(template: any): boolean {
  const buttonComponent = templateComponents(template).find(
    (component) => String(component?.type ?? "").toUpperCase() === "BUTTONS",
  );
  const buttons = Array.isArray(buttonComponent?.buttons) ? buttonComponent.buttons : [];
  if (buttons.length < 2) return false;

  const role = (button: any) => {
    const text = String(button?.text ?? "").trim().toLowerCase();
    const payload = String(button?.payload ?? "").trim().toLowerCase();
    return text === "confirm" || payload === "confirm"
      ? "confirm"
      : text === "cancel" || payload === "cancel"
        ? "cancel"
        : "";
  };
  return (
    String(buttons[0]?.type ?? "").toUpperCase() === "QUICK_REPLY" &&
    String(buttons[1]?.type ?? "").toUpperCase() === "QUICK_REPLY" &&
    role(buttons[0]) === "confirm" &&
    role(buttons[1]) === "cancel"
  );
}

function bodyPlaceholderCount(template: any): number | null {
  const body = templateComponents(template).find(
    (component) => String(component?.type ?? "").toUpperCase() === "BODY",
  );
  if (typeof body?.text !== "string") return null;
  const placeholders = [...body.text.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]));
  return placeholders.length === 0 ? 0 : Math.max(...placeholders);
}

function mappingBodyFields(mapping: unknown): string[] {
  if (Array.isArray(mapping)) return mapping.map(String);
  if (!mapping || typeof mapping !== "object") return [];
  const value = mapping as Record<string, unknown>;
  const body = value.body ?? value;
  if (Array.isArray(body)) return body.map(String);
  if (!body || typeof body !== "object") return [];
  return Object.entries(body as Record<string, unknown>)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, field]) => String(field));
}

function sanitizedMetaTemplate(template: any): Record<string, unknown> {
  return {
    ...(typeof template.id === "string" ? { id: template.id } : {}),
    name: template.name,
    language: templateLanguage(template),
    languageCode: templateLanguage(template),
    status: templateStatus(template),
    ...(template.category === undefined ? {} : { category: template.category }),
    components: templateComponents(template).map((component) => ({
      type: component?.type,
      ...(component?.text === undefined ? {} : { text: component.text }),
      ...(Array.isArray(component?.buttons)
        ? {
            buttons: component.buttons.map((button: any) => ({
              type: button?.type,
              text: button?.text,
            })),
          }
        : {}),
    })),
  };
}

async function accountForTemplateRequest(
  req: ProfileScopedRequest,
  whatsappAccountId: number,
  businessProfileId?: number,
) {
  const profileIds = await accessibleProfiles(req);
  const candidates = businessProfileId === undefined ? profileIds : [businessProfileId];
  if (businessProfileId !== undefined) requireAccessibleProfile(profileIds, businessProfileId);

  for (const profileId of candidates) {
    const account = await findWhatsAppAccountForProfile(whatsappAccountId, profileId);
    if (account) return { account, businessProfileId: profileId, profileIds };
  }

  notFound("WhatsApp account not found");
}

async function integrationForRequest(
  req: ProfileScopedRequest,
  integrationId: number,
) {
  const profileIds = await accessibleProfiles(req);
  const integration = await findOrderIntegrationForProfiles(integrationId, profileIds);
  if (!integration) notFound("Order integration not found");
  return { integration, profileIds };
}

async function templatesForAccount(account: any): Promise<any[]> {
  if (!account.wabaId || !account.accessToken) {
    badRequest("WhatsApp account is missing WABA credentials");
  }

  let accessToken: string;
  try {
    accessToken = decryptFacebookSecret(account.accessToken);
  } catch {
    throw new AppError("WhatsApp account credentials are unavailable", 502, true, "WHATSAPP_CREDENTIALS_UNAVAILABLE");
  }

  const templates = await listWhatsAppTemplates(account.wabaId, accessToken);
  return templates.filter((template) => templateStatus(template) === "APPROVED");
}

async function currentApprovedTemplate(params: {
  account: any;
  templateName: string;
  languageCode: string;
  variableMapping: unknown;
}): Promise<{ template: any; mapping: OrderTemplateMapping }> {
  let mapping: OrderTemplateMapping;
  try {
    mapping = validateOrderTemplateMapping(params.variableMapping, true);
  } catch (error) {
    badRequest(error instanceof Error ? error.message : "Invalid template variable mapping");
  }

  const templates = await templatesForAccount(params.account);
  const template = templates.find(
    (candidate) =>
      candidate?.name === params.templateName &&
      templateLanguage(candidate) === params.languageCode &&
      templateStatus(candidate) === "APPROVED",
  );

  if (!template) badRequest("Selected WhatsApp template is not currently approved");
  if (!hasRequiredQuickReplies(template)) {
    badRequest("Selected WhatsApp template must contain Confirm and Cancel quick replies in order");
  }

  const placeholderCount = bodyPlaceholderCount(template);
  const mappedBodyCount = mappingBodyFields(mapping).length;
  if (placeholderCount !== null && placeholderCount !== mappedBodyCount) {
    badRequest("Template body placeholders must match the selected variable mapping");
  }

  return { template, mapping };
}

function integrationFieldsForUpdate(
  body: Record<string, any>,
  current: any,
  generatedCallbackSecret: string | null,
): {
  data: Record<string, unknown>;
  callbackSecret?: string;
} {
  const data: Record<string, unknown> = {};
  let callbackSecret: string | undefined;

  if (hasOwn(body, "isActive")) data.isActive = body.isActive;
  if (hasOwn(body, "defaultLocale")) data.defaultLocale = body.defaultLocale;
  if (hasOwn(body, "storeSyncEnabled")) data.storeSyncEnabled = body.storeSyncEnabled;
  if (hasOwn(body, "whatsappAccountId")) data.whatsappAccountId = body.whatsappAccountId;

  if (hasOwn(body, "statusCallbackUrl")) {
    data.statusCallbackUrl = parseHttpsCallbackUrl(body.statusCallbackUrl);
  }

  if (generatedCallbackSecret) {
    data.previousStatusCallbackSecret = current.statusCallbackSecret ?? null;
    data.statusCallbackSecret = oneTimeEncryptedSecret(generatedCallbackSecret);
    callbackSecret = generatedCallbackSecret;
  } else if (hasOwn(body, "statusCallbackSecret") || hasOwn(body, "callbackSecret")) {
    const plain = nonBlankSecret(
      hasOwn(body, "statusCallbackSecret") ? body.statusCallbackSecret : body.callbackSecret,
    );
    data.previousStatusCallbackSecret = current.statusCallbackSecret ?? null;
    data.statusCallbackSecret = plain === null ? null : oneTimeEncryptedSecret(plain);
  }

  return { data, ...(callbackSecret ? { callbackSecret } : {}) };
}

function ensureSyncConfiguration(params: {
  enabled: boolean;
  callbackUrl: string | null;
  callbackSecret: string | null;
}): void {
  if (!params.enabled) return;
  if (!params.callbackUrl) badRequest("HTTPS status callback URL is required when synchronization is enabled");
  parseHttpsCallbackUrl(params.callbackUrl);
  if (!params.callbackSecret) badRequest("Status callback secret is required when synchronization is enabled");
}

export async function listIntegrations(req: Request, res: Response): Promise<void> {
  const typedReq = req as ProfileScopedRequest;
  const profileIds = await accessibleProfiles(typedReq);
  const businessProfileId = (req.query as any).businessProfileId as number | undefined;
  if (businessProfileId !== undefined) requireAccessibleProfile(profileIds, businessProfileId);
  const integrations = await listOrderIntegrations({ profileIds, businessProfileId });
  res.json({ data: integrations.map((integration) => serializeIntegration(integration, req)) });
}

export async function createIntegration(req: Request, res: Response): Promise<void> {
  const typedReq = req as ProfileScopedRequest;
  const body = req.body as Record<string, any>;
  const profileIds = await accessibleProfiles(typedReq);
  requireAccessibleProfile(profileIds, body.businessProfileId);

  let whatsappAccountId: number | null = body.whatsappAccountId ?? null;
  if (whatsappAccountId !== null) {
    const account = await findWhatsAppAccountForProfile(whatsappAccountId, body.businessProfileId);
    if (!account) notFound("WhatsApp account not found");
  }

  const callbackUrl = parseHttpsCallbackUrl(body.statusCallbackUrl);
  const plainCallbackSecret = nonBlankSecret(
    hasOwn(body, "statusCallbackSecret") ? body.statusCallbackSecret : body.callbackSecret,
  );
  let generatedCallbackSecret: string | null = null;
  if (body.rotateStatusCallbackSecret || body.rotateCallbackSecret) {
    generatedCallbackSecret = generateRandomToken();
  }
  const callbackSecret = generatedCallbackSecret ?? plainCallbackSecret;
  ensureSyncConfiguration({
    enabled: body.storeSyncEnabled,
    callbackUrl,
    callbackSecret,
  });

  const plainSigningSecret = generateRandomToken();
  const integrationKey = generateRandomToken();
  const record = await createOrderIntegration({
    businessProfileId: body.businessProfileId,
    whatsappAccountId,
    kind: "GENERIC",
    integrationKey,
    signingSecret: oneTimeEncryptedSecret(plainSigningSecret),
    statusCallbackUrl: callbackUrl,
    statusCallbackSecret: callbackSecret === null ? null : oneTimeEncryptedSecret(callbackSecret),
    isActive: body.isActive,
    storeSyncEnabled: body.storeSyncEnabled,
    defaultLocale: body.defaultLocale,
  });

  res.status(201).json({
    data: serializeIntegration(record, req),
    secret: plainSigningSecret,
    ...(generatedCallbackSecret ? { statusCallbackSecret: generatedCallbackSecret } : {}),
  });
}

export async function updateIntegration(req: Request, res: Response): Promise<void> {
  const typedReq = req as ProfileScopedRequest;
  const id = req.params.id as unknown as number;
  const body = req.body as Record<string, any>;
  const { integration, profileIds } = await integrationForRequest(typedReq, id);

  if (hasOwn(body, "whatsappAccountId") && body.whatsappAccountId !== null) {
    const account = await findWhatsAppAccountForProfile(
      body.whatsappAccountId,
      integration.businessProfileId,
    );
    if (!account) notFound("WhatsApp account not found");
  }

  const generatedCallbackSecret = body.rotateStatusCallbackSecret || body.rotateCallbackSecret
    ? generateRandomToken()
    : null;
  const fields = integrationFieldsForUpdate(body, integration, generatedCallbackSecret);
  const callbackUrl = hasOwn(fields.data, "statusCallbackUrl")
    ? (fields.data.statusCallbackUrl as string | null)
    : integration.statusCallbackUrl;
  const callbackSecret = generatedCallbackSecret
    ? generatedCallbackSecret
    : hasOwn(body, "statusCallbackSecret") || hasOwn(body, "callbackSecret")
      ? nonBlankSecret(
          hasOwn(body, "statusCallbackSecret") ? body.statusCallbackSecret : body.callbackSecret,
        )
      : integration.statusCallbackSecret;
  const enabled = hasOwn(body, "storeSyncEnabled")
    ? body.storeSyncEnabled
    : integration.storeSyncEnabled;
  ensureSyncConfiguration({ enabled, callbackUrl, callbackSecret });

  const record = await updateOrderIntegration({
    id,
    businessProfileId: integration.businessProfileId,
    data: fields.data as any,
  });
  void profileIds;
  res.json({
    data: serializeIntegration(record, req),
    ...(fields.callbackSecret ? { statusCallbackSecret: fields.callbackSecret } : {}),
  });
}

export async function rotateSecret(req: Request, res: Response): Promise<void> {
  const typedReq = req as ProfileScopedRequest;
  const id = req.params.id as unknown as number;
  const { integration } = await integrationForRequest(typedReq, id);
  const plainSecret = generateRandomToken();
  const record = await rotateOrderIntegrationSecret({
    id,
    businessProfileId: integration.businessProfileId,
    signingSecret: oneTimeEncryptedSecret(plainSecret),
    previousSigningSecret: integration.signingSecret,
  });

  res.json({ data: serializeIntegration(record, req), secret: plainSecret });
}

export async function listApprovedTemplates(req: Request, res: Response): Promise<void> {
  const accountId = (req.query as any).whatsappAccountId as number;
  const businessProfileId = (req.query as any).businessProfileId as number | undefined;
  const { account } = await accountForTemplateRequest(
    req as ProfileScopedRequest,
    accountId,
    businessProfileId,
  );
  const templates = await templatesForAccount(account);
  res.json({ data: templates.map(sanitizedMetaTemplate) });
}

export async function listTemplateConfigs(req: Request, res: Response): Promise<void> {
  const typedReq = req as ProfileScopedRequest;
  const profileIds = await accessibleProfiles(typedReq);
  let businessProfileId = (req.query as any).businessProfileId as number | undefined;
  let whatsappAccountId = (req.query as any).whatsappAccountId as number | undefined;
  const integrationId = (req.query as any).integrationId as number | undefined;
  if (businessProfileId !== undefined) requireAccessibleProfile(profileIds, businessProfileId);
  if (integrationId !== undefined) {
    const integration = await findOrderIntegrationForProfiles(integrationId, profileIds);
    if (!integration) notFound("Order integration not found");
    if (
      businessProfileId !== undefined &&
      businessProfileId !== integration.businessProfileId
    ) {
      notFound("Order integration not found");
    }
    businessProfileId = integration.businessProfileId;
    if (whatsappAccountId === undefined) whatsappAccountId = integration.whatsappAccountId ?? undefined;
  }
  if (whatsappAccountId !== undefined) {
    const accountProfiles = businessProfileId === undefined ? profileIds : [businessProfileId];
    let accountBelongsToProfile = false;
    for (const profileId of accountProfiles) {
      if (await findWhatsAppAccountForProfile(whatsappAccountId, profileId)) {
        accountBelongsToProfile = true;
        break;
      }
    }
    if (!accountBelongsToProfile) notFound("WhatsApp account not found");
  }
  const configs = await listOrderTemplateConfigs({
    profileIds,
    businessProfileId,
    whatsappAccountId,
    eventType: (req.query as any).eventType,
    locale: (req.query as any).locale,
  });
  res.json({ data: configs.map(serializeTemplateConfig) });
}

async function resolveTemplateTarget(req: ProfileScopedRequest, body: Record<string, any>) {
  const profileIds = await accessibleProfiles(req);
  let integration: OrderIntegrationManagementRecord | null = null;
  if (body.integrationId !== undefined) {
    integration = await findOrderIntegrationForProfiles(body.integrationId, profileIds);
    if (!integration) notFound("Order integration not found");
    if (
      body.businessProfileId !== undefined &&
      body.businessProfileId !== integration.businessProfileId
    ) {
      notFound("Order integration not found");
    }
  }

  const businessProfileId = integration?.businessProfileId ?? body.businessProfileId;
  if (typeof businessProfileId !== "number") {
    badRequest("businessProfileId or integrationId is required");
  }
  requireAccessibleProfile(profileIds, businessProfileId);
  if (typeof body.whatsappAccountId !== "number") badRequest("whatsappAccountId is required");
  const account = await findWhatsAppAccountForProfile(body.whatsappAccountId, businessProfileId);
  if (!account) notFound("WhatsApp account not found");

  return { profileIds, integration, businessProfileId, account };
}

export async function createTemplateConfig(req: Request, res: Response): Promise<void> {
  const body = req.body as Record<string, any>;
  const target = await resolveTemplateTarget(req as ProfileScopedRequest, body);
  const current = await currentApprovedTemplate({
    account: target.account,
    templateName: body.templateName,
    languageCode: body.languageCode,
    variableMapping: body.variableMapping,
  });
  const record = await createOrderTemplateConfig({
    businessProfileId: target.businessProfileId,
    whatsappAccountId: body.whatsappAccountId,
    eventType: DEFAULT_EVENT_TYPE,
    locale: body.locale,
    templateName: body.templateName,
    languageCode: body.languageCode,
    templateVersion: body.templateVersion,
    variableMapping: current.mapping as any,
    approvalStatus: "APPROVED",
    isActive: body.isActive,
  });
  res.status(201).json({ data: serializeTemplateConfig(record) });
}

export async function updateTemplateConfig(req: Request, res: Response): Promise<void> {
  const typedReq = req as ProfileScopedRequest;
  const id = req.params.id as unknown as number;
  const profileIds = await accessibleProfiles(typedReq);
  const current = await findOrderTemplateConfigByIdForProfiles(id, profileIds);
  if (!current) notFound("Order template configuration not found");

  const body = req.body as Record<string, any>;
  const businessProfileId = current.businessProfileId;
  const whatsappAccountId = body.whatsappAccountId ?? current.whatsappAccountId;
  const account = await findWhatsAppAccountForProfile(whatsappAccountId, businessProfileId);
  if (!account) notFound("WhatsApp account not found");

  const finalName = body.templateName ?? current.templateName;
  const finalLanguageCode = body.languageCode ?? current.languageCode;
  const finalMapping = body.variableMapping ?? current.variableMapping;
  const finalActive = body.isActive ?? current.isActive;
  let validatedMapping: OrderTemplateMapping = finalMapping as OrderTemplateMapping;
  if (finalActive || hasOwn(body, "templateName") || hasOwn(body, "languageCode") || hasOwn(body, "variableMapping")) {
    const approved = await currentApprovedTemplate({
      account,
      templateName: finalName,
      languageCode: finalLanguageCode,
      variableMapping: finalMapping,
    });
    validatedMapping = approved.mapping;
  }

  const data: Record<string, unknown> = {};
  if (hasOwn(body, "whatsappAccountId")) data.whatsappAccountId = whatsappAccountId;
  if (hasOwn(body, "locale")) data.locale = body.locale;
  if (hasOwn(body, "templateName")) data.templateName = finalName;
  if (hasOwn(body, "languageCode")) data.languageCode = finalLanguageCode;
  if (hasOwn(body, "templateVersion")) data.templateVersion = body.templateVersion;
  if (hasOwn(body, "variableMapping")) data.variableMapping = validatedMapping as any;
  if (hasOwn(body, "isActive")) data.isActive = body.isActive;
  if (finalActive && !hasOwn(body, "variableMapping")) data.variableMapping = validatedMapping as any;
  if (finalActive) data.approvalStatus = "APPROVED";

  const record = await updateOrderTemplateConfig({
    id,
    businessProfileId,
    data: data as any,
    ...(finalActive
      ? {
          activateKey: {
            whatsappAccountId,
            eventType: current.eventType,
            locale: body.locale ?? current.locale,
          },
        }
      : {}),
  });
  res.json({ data: serializeTemplateConfig(record) });
}

export async function testEvent(req: Request, res: Response): Promise<void> {
  const typedReq = req as ProfileScopedRequest;
  const id = req.params.id as unknown as number;
  const { integration } = await integrationForRequest(typedReq, id);
  if (!integration.whatsappAccountId) badRequest("A WhatsApp account must be selected before testing an event");

  const account = await findWhatsAppAccountForProfile(
    integration.whatsappAccountId,
    integration.businessProfileId,
  );
  if (!account) notFound("WhatsApp account not found");

  const body = req.body as Record<string, any>;
  const rawEvent = body.event && typeof body.event === "object" ? body.event : body;
  let event: ReturnType<typeof normalizeCanonicalOrderEvent>;
  try {
    event = normalizeCanonicalOrderEvent(rawEvent);
  } catch (error) {
    badRequest(error instanceof Error ? error.message : "Invalid canonical order event");
  }

  const locale = body.locale ?? event.order.customer.locale ?? integration.defaultLocale;
  if (locale !== "ar" && locale !== "en") badRequest("Test event locale must be ar or en");
  const config = await findOrderTemplateConfigForTest({
    id: typeof body.templateConfigId === "number" ? body.templateConfigId : undefined,
    businessProfileId: integration.businessProfileId,
    whatsappAccountId: integration.whatsappAccountId,
    eventType: DEFAULT_EVENT_TYPE,
    locale,
  });
  if (!config || !config.isActive || config.approvalStatus !== "APPROVED") {
    notFound("No active approved WhatsApp order template is configured for this locale");
  }

  let mapping: OrderTemplateMapping;
  try {
    mapping = validateOrderTemplateMapping(config.variableMapping, true);
  } catch (error) {
    badRequest(error instanceof Error ? error.message : "Invalid template variable mapping");
  }
  const rendered = renderOrderTemplateVariables(
    event.order,
    mapping,
    { confirm: "preview-confirm", cancel: "preview-cancel" },
    locale,
  );

  res.json({
    data: {
      templateConfigId: config.id,
      templateName: config.templateName,
      languageCode: config.languageCode,
      locale,
      ...rendered,
    },
  });
}

export async function listOrders(req: Request, res: Response): Promise<void> {
  const typedReq = req as ProfileScopedRequest;
  const profileIds = await accessibleProfiles(typedReq);
  const businessProfileId = (req.query as any).businessProfileId as number | undefined;
  if (businessProfileId !== undefined) requireAccessibleProfile(profileIds, businessProfileId);
  const result = await listManagedOrders({
    profileIds,
    businessProfileId,
    integrationId: (req.query as any).integrationId,
    status: (req.query as any).status,
    page: (req.query as any).page,
    limit: (req.query as any).limit,
  });
  res.json({ data: result.data.map(serializeOrder), meta: result.meta });
}

export async function getOrder(req: Request, res: Response): Promise<void> {
  const profileIds = await accessibleProfiles(req as ProfileScopedRequest);
  const order = await findManagedOrder(req.params.id as unknown as number, profileIds);
  if (!order) notFound("Order confirmation not found");
  res.json({ data: serializeOrder(order) });
}

export async function retryNotification(req: Request, res: Response): Promise<void> {
  const profileIds = await accessibleProfiles(req as ProfileScopedRequest);
  const notification = await findNotificationForManagementRetry(
    req.params.id as unknown as number,
    profileIds,
  );
  if (!notification) notFound("Order notification not found");
  if (notification.status !== "FAILED") conflict("Only failed notifications can be retried");
  if (
    (notification.kind === "CONFIRMATION_REQUEST" && notification.order.status !== "AWAITING_CONFIRMATION") ||
    (notification.kind === "ACKNOWLEDGEMENT" && notification.order.status === "AWAITING_CONFIRMATION")
  ) {
    conflict("This notification is no longer eligible for retry");
  }

  const queued = await requeueNotificationForRetry(notification.id, notification.businessProfileId);
  if (!queued) conflict("Notification retry was already claimed");
  await enqueueNotificationRetry(notification.id, `management-notification-retry-${notification.id}`);
  res.status(202).json({ data: { queued: true, notificationId: notification.id } });
}

export async function retryStoreSync(req: Request, res: Response): Promise<void> {
  const profileIds = await accessibleProfiles(req as ProfileScopedRequest);
  const sync = await findStoreSyncForManagementRetry(req.params.id as unknown as number, profileIds);
  if (!sync) notFound("Order store sync not found");
  if (sync.status !== "FAILED") conflict("Only failed store synchronizations can be retried");
  if (sync.order.status !== sync.requestedStatus) {
    conflict("This store synchronization is no longer eligible for retry");
  }

  const queued = await requeueStoreSyncForRetry(sync.id, sync.businessProfileId);
  if (!queued) conflict("Store synchronization retry was already claimed");
  await enqueueStoreSyncRetry(sync.id, `management-store-sync-retry-${sync.id}`);
  res.status(202).json({ data: { queued: true, syncId: sync.id } });
}

function settingEnabled(value: string): boolean {
  return !["false", "0", "off", "disabled", "no"].includes(value.trim().toLowerCase());
}

async function globalState(): Promise<{ enabled: boolean; updatedAt: string | null }> {
  const value = await getSystemSetting(GLOBAL_SETTING_KEY, "true");
  const updatedAt = await findSystemSettingUpdatedAt(GLOBAL_SETTING_KEY);
  return { enabled: settingEnabled(value), updatedAt: updatedAt?.toISOString() ?? null };
}

export async function getGlobalState(_req: Request, res: Response): Promise<void> {
  res.json({ data: await globalState() });
}

export async function updateGlobalState(req: Request, res: Response): Promise<void> {
  await updateSystemSetting(GLOBAL_SETTING_KEY, String(req.body.enabled));
  const state = await globalState();
  res.json({ data: state });
}
