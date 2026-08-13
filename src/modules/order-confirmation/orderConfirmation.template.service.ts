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
]);

export type OrderTemplateMapping =
  | readonly OrderTemplateField[]
  | {
      body: readonly OrderTemplateField[] | Readonly<Record<string, OrderTemplateField>>;
      buttons?: readonly string[] | Readonly<Record<string, string>>;
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
  if (Array.isArray(value)) return value as readonly OrderTemplateField[];
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

function validateMapping(mapping: OrderTemplateMapping, requireButtons = true): void {
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
    if (
      requireButtons &&
      (buttons[0] !== "confirmToken" || buttons[1] !== "cancelToken")
    ) {
      throw new Error("Confirm and Cancel button parameters must be in order");
    }
  }
}

export function validateOrderTemplateMapping(
  mapping: OrderTemplateMapping | unknown,
  requireButtons = true,
): OrderTemplateMapping {
  const normalizedMapping = asMapping(mapping);
  validateMapping(normalizedMapping, requireButtons);
  return normalizedMapping;
}

export async function resolveActiveTemplateConfig(params: {
  integrationId: number;
  businessProfileId?: number;
  whatsappAccountId: number;
  locale: string;
  eventType: string;
}): Promise<OrderTemplateConfig> {
  const config = await prisma.orderTemplateConfig.findFirst({
    where: {
      ...(params.businessProfileId === undefined
        ? {}
        : { businessProfileId: params.businessProfileId }),
      whatsappAccountId: params.whatsappAccountId,
      eventType: params.eventType,
      locale: params.locale,
      isActive: true,
      approvalStatus: "APPROVED",
      whatsappAccount: {
        orderIntegrations: {
          some: {
            id: params.integrationId,
            ...(params.businessProfileId === undefined
              ? {}
              : { businessProfileId: params.businessProfileId }),
          },
        },
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

  if (
    params.businessProfileId !== undefined &&
    config.businessProfileId !== params.businessProfileId
  ) {
    throw new Error("WhatsApp order template belongs to another business profile");
  }

  if (config.approvalStatus && config.approvalStatus !== "APPROVED") {
    throw new Error("Configured WhatsApp order template is not approved");
  }

  const variableMapping = validateOrderTemplateMapping(config.variableMapping);

  return { ...config, variableMapping };
}

function localizedDigits(value: string, locale: string): string {
  const digitFormatter = new Intl.NumberFormat(locale, { useGrouping: false });
  const digits = new Map<string, string>();
  for (let digit = 0; digit <= 9; digit += 1) {
    digits.set(String(digit), digitFormatter.format(digit));
  }
  return [...value].map((character) => digits.get(character) ?? character).join("");
}

function formatMoneyWithoutNumber(
  rawTotal: string,
  currency: string,
  locale: string,
): string {
  if (!/^\d+(?:\.\d+)?$/.test(rawTotal)) {
    return `${currency} ${rawTotal}`.trim();
  }

  try {
    const formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 20,
    });
    const pattern = formatter.formatToParts(1.1);
    const firstInteger = pattern.findIndex((part) => part.type === "integer");
    let lastNumber = -1;
    for (let index = 0; index < pattern.length; index += 1) {
      if (pattern[index]?.type === "integer" || pattern[index]?.type === "fraction") {
        lastNumber = index;
      }
    }
    if (firstInteger < 0 || lastNumber < firstInteger) {
      return `${currency} ${rawTotal}`.trim();
    }

    const prefix = pattern.slice(0, firstInteger).map((part) => part.value).join("");
    const suffix = pattern.slice(lastNumber + 1).map((part) => part.value).join("");
    const decimalSeparator =
      pattern.find((part) => part.type === "decimal")?.value ?? ".";
    const [integerPart, fractionPart] = rawTotal.split(".");
    const localizedInteger = localizedDigits(integerPart, locale);
    const localizedFraction = fractionPart
      ? `${decimalSeparator}${localizedDigits(fractionPart, locale)}`
      : "";

    return `${prefix}${localizedInteger}${localizedFraction}${suffix}`;
  } catch {
    return `${currency} ${rawTotal}`.trim();
  }
}

function readOrderValue(
  order: CanonicalOrder | Record<string, unknown>,
  field: string,
  selectedLocale?: string,
): string {
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
      const locale = selectedLocale ?? String(source.locale ?? customer.locale ?? "en");
      return formatMoneyWithoutNumber(rawTotal, currency, locale);
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
  selectedLocale?: string,
): RenderedOrderTemplateVariables {
  const normalizedMapping = validateOrderTemplateMapping(mapping, true);

  const body = bodyFields(normalizedMapping).map((field) =>
    readOrderValue(order, field, selectedLocale),
  );
  const rendered: RenderedOrderTemplateVariables = {
    body,
    previewText: body.filter(Boolean).join(" | "),
  };

  if (actionTokens) {
    rendered.buttons = actionTokens;
  }

  return rendered;
}
