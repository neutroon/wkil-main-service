import type { OrderTemplateField } from "./orderConfirmation.types";
import { listOrderTemplateFields } from "./orderConfirmation.fields";
const allowedOrderFields = new Set<string>(listOrderTemplateFields().map(field => field.id));
const allowedButtonFields = new Set(["confirmToken", "cancelToken"]);
export type OrderTemplateMapping =
  | readonly OrderTemplateField[]
  | {
      body: readonly OrderTemplateField[] | Readonly<Record<string, OrderTemplateField>>;
      buttons?: readonly string[] | Readonly<Record<string, string>>;
    }
  | Record<string, OrderTemplateField>;

function asMapping(value: unknown): OrderTemplateMapping {
  if (Array.isArray(value)) return value as readonly OrderTemplateField[];
  if (typeof value !== "object" || value === null) {
    throw new Error("Template variable mapping must be an object or array");
  }

  return value as OrderTemplateMapping;
}

function normalizeLegacyField(value: unknown): string {
  // Existing saved configurations used `currency` for this template slot.
  // Keep those configurations readable while making quantity the canonical field.
  return value === "currency" ? "quantity" : String(value);
}

function normalizeFieldCollection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeLegacyField);
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, field]) => [
      key,
      normalizeLegacyField(field),
    ]),
  );
}

function normalizeOrderTemplateMapping(value: OrderTemplateMapping): OrderTemplateMapping {
  if (Array.isArray(value)) return value.map(normalizeLegacyField) as OrderTemplateField[];

  if ("body" in value) {
    return {
      ...value,
      body: normalizeFieldCollection(value.body) as OrderTemplateField[] | Record<string, OrderTemplateField>,
      ...(value.buttons === undefined
        ? {}
        : { buttons: normalizeFieldCollection(value.buttons) as string[] | Record<string, string> }),
    };
  }

  return normalizeFieldCollection(value) as Record<string, OrderTemplateField>;
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

export function orderTemplateUsesActions(mapping: OrderTemplateMapping | unknown): boolean {
  return buttonFields(asMapping(mapping)).length > 0;
}

function validateMapping(mapping: OrderTemplateMapping, requireButtons = false): void {
  const body = bodyFields(mapping);
  if (body.length > 0) validateFieldList(body, allowedOrderFields, "body");

  const buttons = buttonFields(mapping);
  if (requireButtons && buttons.length === 0) {
    throw new Error("Confirm and Cancel button parameters are required");
  }
  if (buttons.length > 0) {
    validateFieldList(buttons, allowedButtonFields, "button");
    if (buttons.length !== 2) {
      throw new Error("Confirm and Cancel button parameters are required");
    }
    if (
      (buttons[0] !== "confirmToken" || buttons[1] !== "cancelToken")
    ) {
      throw new Error("Confirm and Cancel button parameters must be in order");
    }
  }
}

export function validateOrderTemplateMapping(
  mapping: OrderTemplateMapping | unknown,
  requireButtons = false,
): OrderTemplateMapping {
  const normalizedMapping = normalizeOrderTemplateMapping(asMapping(mapping));
  validateMapping(normalizedMapping, requireButtons);
  return normalizedMapping;
}


export function getBodyMappingEntries(mapping: OrderTemplateMapping): Array<{ placeholder: string; field: OrderTemplateField }> {
  const normalized = validateOrderTemplateMapping(mapping);
  const value = Array.isArray(normalized) ? normalized : "body" in normalized ? normalized.body : normalized;
  if (Array.isArray(value)) return value.map((field, index) => ({ placeholder: String(index + 1), field: field as OrderTemplateField }));
  return Object.entries(value).sort(([left], [right]) => {
    const a = Number(left), b = Number(right);
    return Number.isFinite(a) && Number.isFinite(b) ? a - b : left.localeCompare(right);
  }).map(([placeholder, field]) => ({ placeholder, field: field as OrderTemplateField }));
}
