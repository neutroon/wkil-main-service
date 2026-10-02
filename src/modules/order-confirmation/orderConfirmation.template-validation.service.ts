import { inspectOrderTemplateVariables } from "./orderConfirmation.template-inspection";
import { ZodError } from "zod";
import { listOrderTemplateFields } from "./orderConfirmation.fields";
import { getBodyMappingEntries, orderTemplateUsesActions, validateOrderTemplateMapping } from "./orderConfirmation.template-mapping";
import { findOrderTemplateConfigForTest } from "./orderConfirmation.repository";
import { parseCanonicalOrderEvent } from "./orderConfirmation.validation";
import { normalizeCanonicalOrderEvent } from "./orderConfirmation.normalizer";
import type { OrderTemplateConfig } from "./orderConfirmation.template.service";
import type { OrderTemplateContext, TemplateRequirements, TemplateValidationResult, TemplateVariableIssue } from "./orderConfirmation.integration.types";
import type { OrderTemplateMapping } from "./orderConfirmation.template-mapping";

export class OrderTemplateDataIncompleteError extends Error {
  readonly code = "TEMPLATE_DATA_INCOMPLETE";
  constructor(readonly issues: TemplateVariableIssue[]) {
    super(`Missing template data: ${issues.map(issue => `{{${issue.placeholder}}} ${issue.field} (${issue.paths.join(", ")})`).join("; ")}`);
    this.name = "OrderTemplateDataIncompleteError";
  }
}
export class OrderTemplateConfigurationError extends Error {
  constructor(readonly code: "WHATSAPP_ACCOUNT_NOT_CONFIGURED" | "TEMPLATE_NOT_CONFIGURED") {
    super(code === "WHATSAPP_ACCOUNT_NOT_CONFIGURED" ? "A WhatsApp account must be configured" : "An active approved order template must be configured");
  }
}
export { inspectOrderTemplateVariables } from "./orderConfirmation.template-inspection";
export async function resolveOrderTemplateForIntegration(context: OrderTemplateContext, options: { locale?: "ar" | "en"; templateConfigId?: number } = {}): Promise<OrderTemplateConfig> {
  if (!context.whatsappAccountId) throw new OrderTemplateConfigurationError("WHATSAPP_ACCOUNT_NOT_CONFIGURED");
  const locales = [...new Set([options.locale ?? context.defaultLocale, context.defaultLocale])];
  for (const locale of locales) {
    const config = await findOrderTemplateConfigForTest({ id: options.templateConfigId, integrationId: context.integrationId, businessProfileId: context.businessProfileId, whatsappAccountId: context.whatsappAccountId, eventType: "order.created", locale });
    if (!config || !config.isActive || config.approvalStatus !== "APPROVED") continue;
    if (config.businessProfileId !== context.businessProfileId || config.whatsappAccountId !== context.whatsappAccountId || (options.templateConfigId !== undefined && config.id !== options.templateConfigId)) continue;
    try { return { ...config, variableMapping: validateOrderTemplateMapping(config.variableMapping) }; }
    catch { throw new OrderTemplateConfigurationError("TEMPLATE_NOT_CONFIGURED"); }
  }
  throw new OrderTemplateConfigurationError("TEMPLATE_NOT_CONFIGURED");
}
export async function getOrderTemplateRequirements(context: OrderTemplateContext, locale?: "ar" | "en"): Promise<TemplateRequirements> {
  const config = await resolveOrderTemplateForIntegration(context, { locale });
  const supportedFields = listOrderTemplateFields();
  return { schemaVersion: "1", supportedFields, template: { id: config.id, name: config.templateName, languageCode: config.languageCode, locale: config.locale as "ar" | "en", variableMapping: config.variableMapping, variables: getBodyMappingEntries(config.variableMapping).map(entry => ({ component: "body", ...entry, paths: supportedFields.find(field => field.id === entry.field)!.requiredPaths })) } };
}
export async function validateOrderEventForTemplate(input: unknown, context: OrderTemplateContext, options: { locale?: "ar" | "en"; templateConfigId?: number; canonicalOnly?: boolean } = {}): Promise<TemplateValidationResult> {
  let event;
  try { event = options.canonicalOnly === false ? normalizeCanonicalOrderEvent(input) : parseCanonicalOrderEvent(input); }
  catch (error) {
    return { status: 400, body: { code: "INVALID_ORDER_EVENT", message: "Order event does not match the contract", retryable: false, errors: error instanceof ZodError ? error.issues.map(issue => ({ paths: [issue.path.join(".") || "$"], reason: issue.code })) : [{ paths: ["$"], reason: "invalid" }] } };
  }
  let config;
  try { config = await resolveOrderTemplateForIntegration(context, { ...options, locale: options.locale ?? event.order.customer.locale ?? context.defaultLocale }); }
  catch (error) {
    if (!(error instanceof OrderTemplateConfigurationError)) throw error;
    return { status: 409, body: { code: error.code, message: error.message, retryable: false, errors: [] } };
  }
  const inspection = inspectOrderTemplateVariables(event.order, config.variableMapping, config.locale);
  if (inspection.errors.length) return { status: 422, body: { code: "TEMPLATE_DATA_INCOMPLETE", message: "Some mapped template fields have no usable value", retryable: false, errors: inspection.errors } };
  return { status: 200, body: { data: { schemaVersion: "1", schemaValid: true, templateReady: true, templateConfigId: config.id, templateName: config.templateName, languageCode: config.languageCode, locale: config.locale as "ar" | "en", body: inspection.body, previewText: inspection.previewText, variables: inspection.variables, ...(orderTemplateUsesActions(config.variableMapping) ? { buttons: { confirm: "preview-confirm", cancel: "preview-cancel" } } : {}) } } };
}
