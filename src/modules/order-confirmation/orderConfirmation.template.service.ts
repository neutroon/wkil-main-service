import prisma from "@config/prisma";
import type { CanonicalOrder, OrderTemplateField } from "./orderConfirmation.types";

const allowedOrderFields = new Set<OrderTemplateField>([
  "customerName",
  "orderNumber",
  "itemSummary",
  "total",
  "currency",
  "shippingCity",
  "shippingCountry",
]);

const allowedButtonFields = new Set([
  "confirmToken",
  "cancelToken",
  "actionToken",
]);

export type OrderTemplateMapping =
  | OrderTemplateField[]
  | {
      body: OrderTemplateField[] | Record<string, OrderTemplateField>;
      buttons?: string[] | Record<string, string>;
    }
  | Record<string, OrderTemplateField>;

export type OrderTemplateConfig = {
  id: number;
  businessProfileId: number;
  whatsappAccountId: number;
  eventType: string;
  locale: string;
  templateName: string;
  languageCode: string;
  templateVersion: number;
  isActive: boolean;
  approvalStatus: string | null;
  variableMapping: OrderTemplateMapping;
};

export type RenderedOrderTemplateVariables = {
  body: string[];
  buttons?: {
    confirm: string;
    cancel: string;
  };
  previewText: string;
};

function asMapping(value: unknown): OrderTemplateMapping {
  if (Array.isArray(value)) return value as OrderTemplateField[];
  if (typeof value !== "object" || value === null) {
    throw new Error("Template variable mapping must be an object or array");
  }

  return value as OrderTemplateMapping;
}

function valuesInPlaceholderOrder(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "object" || value === null) return [];

  return Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => {
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
        return leftNumber - rightNumber;
      }
      return left.localeCompare(right);
    })
    .map(([, field]) => String(field));
}

function bodyFields(mapping: OrderTemplateMapping): string[] {
  if (Array.isArray(mapping)) return mapping.map(String);
  if ("body" in mapping) return valuesInPlaceholderOrder(mapping.body);
  return valuesInPlaceholderOrder(mapping);
}

function buttonFields(mapping: OrderTemplateMapping): string[] {
  if (Array.isArray(mapping) || !("buttons" in mapping) || mapping.buttons === undefined) {
    return [];
  }
  return valuesInPlaceholderOrder(mapping.buttons);
}

function validateFieldList(fields: string[], allowed: Set<string>, label: string): void {
  if (fields.length === 0) {
    throw new Error(`${label} mapping is required`);
  }

  for (const field of fields) {
    if (!allowed.has(field)) {
      throw new Error(`Unknown ${label} field: ${field}`);
    }
  }
}

function validateMapping(mapping: OrderTemplateMapping, requireButtons = false): void {
  validateFieldList(bodyFields(mapping), allowedOrderFields, "body");

  const buttons = buttonFields(mapping);
  if (requireButtons && buttons.length === 0) {
    throw new Error("Confirm and Cancel button parameters are required");
  }
  if (buttons.length > 0) {
    validateFieldList(buttons, allowedButtonFields, "button");
    if (requireButtons && buttons.length !== 2) {
      throw new Error("Confirm and Cancel button parameters are required");
    }
    if (requireButtons && !buttons.includes("confirmToken")) {
      throw new Error("Confirm button parameter must map to confirmToken");
    }
    if (requireButtons && !buttons.includes("cancelToken")) {
      throw new Error("Cancel button parameter must map to cancelToken");
    }
  }
}

export function validateOrderTemplateMapping(
  mapping: OrderTemplateMapping | unknown,
  requireButtons = false,
): OrderTemplateMapping {
  const normalizedMapping = asMapping(mapping);
  validateMapping(normalizedMapping, requireButtons);
  return normalizedMapping;
}

export async function resolveActiveTemplateConfig(params: {
  integrationId: number;
  whatsappAccountId: number;
  locale: string;
  eventType: string;
}): Promise<OrderTemplateConfig> {
  const config = await prisma.orderTemplateConfig.findFirst({
    where: {
      whatsappAccountId: params.whatsappAccountId,
      eventType: params.eventType,
      locale: params.locale,
      isActive: true,
      approvalStatus: "APPROVED",
      whatsappAccount: {
        orderIntegrations: { some: { id: params.integrationId } },
      },
    },
    select: {
      id: true,
      businessProfileId: true,
      whatsappAccountId: true,
      eventType: true,
      locale: true,
      templateName: true,
      languageCode: true,
      templateVersion: true,
      isActive: true,
      approvalStatus: true,
      variableMapping: true,
    },
  });

  if (!config) {
    throw new Error("No active WhatsApp order template is configured");
  }

  if (config.approvalStatus && config.approvalStatus !== "APPROVED") {
    throw new Error("Configured WhatsApp order template is not approved");
  }

  const variableMapping = validateOrderTemplateMapping(config.variableMapping);

  return { ...config, variableMapping };
}

function readOrderValue(order: CanonicalOrder | Record<string, unknown>, field: string): string {
  const source = order as Record<string, unknown>;
  const customer = (source.customer ?? {}) as Record<string, unknown>;
  const shippingAddress = (source.shippingAddress ?? {}) as Record<string, unknown>;

  switch (field) {
    case "customerName":
      return String(source.customerName ?? customer.name ?? "");
    case "orderNumber":
      return String(source.orderNumber ?? source.number ?? "");
    case "itemSummary": {
      const items = (source.lineItems ?? source.items) as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(items)) return "";
      return items
        .map((item) => `${String(item.name ?? "")} x ${String(item.quantity ?? "")}`.trim())
        .filter(Boolean)
        .join(", ");
    }
    case "total": {
      const rawTotal = String(source.total ?? "");
      const currency = String(source.currency ?? "USD");
      const locale = String(source.locale ?? customer.locale ?? "en");
      const numericTotal = Number(rawTotal);
      if (!Number.isFinite(numericTotal)) return `${currency} ${rawTotal}`.trim();
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
      }).format(numericTotal);
    }
    case "currency":
      return String(source.currency ?? "");
    case "shippingCity":
      return String(shippingAddress.city ?? "");
    case "shippingCountry":
      return String(shippingAddress.country ?? "");
    default:
      throw new Error(`Unknown order template field: ${field}`);
  }
}

export function renderOrderTemplateVariables(
  order: CanonicalOrder | Record<string, unknown>,
  mapping: OrderTemplateMapping | unknown,
  actionTokens?: { confirm: string; cancel: string },
): RenderedOrderTemplateVariables {
  const normalizedMapping = validateOrderTemplateMapping(mapping);

  const body = bodyFields(normalizedMapping).map((field) => readOrderValue(order, field));
  const rendered: RenderedOrderTemplateVariables = {
    body,
    previewText: body.filter(Boolean).join(" | "),
  };

  if (actionTokens) {
    rendered.buttons = actionTokens;
  }

  return rendered;
}
