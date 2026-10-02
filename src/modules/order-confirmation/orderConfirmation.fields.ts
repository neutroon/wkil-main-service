import type { CanonicalOrder, OrderTemplateField } from "./orderConfirmation.types";
import type { TemplateFieldDescriptor, TemplateVariableIssue } from "./orderConfirmation.integration.types";

const descriptors: TemplateFieldDescriptor[] = [
  { id: "customerName", labels: { en: "Customer Name", ar: "اسم العميل" }, paths: ["order.customer.name"], requiredPaths: ["order.customer.name"], rule: "nonblank" },
  { id: "orderNumber", labels: { en: "Order Number", ar: "رقم الطلب" }, paths: ["order.number"], requiredPaths: ["order.number"], rule: "nonblank" },
  { id: "itemSummary", labels: { en: "Items", ar: "المنتجات" }, paths: ["order.items[].name"], requiredPaths: ["order.items[].name"], rule: "any-item-name" },
  { id: "quantity", labels: { en: "Quantity", ar: "الكمية" }, paths: ["order.items[].quantity"], requiredPaths: ["order.items[].quantity"], rule: "any-item-quantity" },
  { id: "total", labels: { en: "Total", ar: "الإجمالي" }, paths: ["order.total", "order.currency"], requiredPaths: ["order.total", "order.currency"], rule: "money" },
  { id: "shippingCity", labels: { en: "Shipping City", ar: "مدينة الشحن" }, paths: ["order.shippingAddress.city"], requiredPaths: ["order.shippingAddress.city"], rule: "nonblank" },
  { id: "shippingCountry", labels: { en: "Shipping Country", ar: "بلد الشحن" }, paths: ["order.shippingAddress.country"], requiredPaths: ["order.shippingAddress.country"], rule: "nonblank" },
  { id: "shippingFullAddress", labels: { en: "Shipping Address", ar: "عنوان الشحن" }, paths: ["order.shippingAddress.addressLine1", "order.shippingAddress.addressLine2", "order.shippingAddress.city", "order.shippingAddress.state", "order.shippingAddress.postalCode", "order.shippingAddress.country"], requiredPaths: ["order.shippingAddress.addressLine1"], rule: "street-address" },
];

export function listOrderTemplateFields(): TemplateFieldDescriptor[] {
  return descriptors.map(field => ({ ...field, labels: { ...field.labels }, paths: [...field.paths], requiredPaths: [...field.requiredPaths] }));
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function valueReason(value: unknown): TemplateVariableIssue["reason"] | undefined {
  if (value === undefined || value === null) return "missing";
  if (typeof value !== "string" && typeof value !== "number") return "invalid";
  return String(value).trim() ? undefined : "blank";
}

export function renderOrderTemplateField(order: CanonicalOrder | Record<string, unknown>, field: OrderTemplateField, locale: string): { text: string; reason?: TemplateVariableIssue["reason"] } {
  if (!descriptors.some(entry => entry.id === field)) throw new Error(`Unknown order template field: ${field}`);
  const source = record(order), customer = record(source.customer), address = record(source.shippingAddress);
  let values: unknown[];
  switch (field) {
    case "customerName": values = [source.customerName ?? customer.name]; break;
    case "orderNumber": values = [source.orderNumber ?? source.number]; break;
    case "shippingCity": values = [address.city]; break;
    case "shippingCountry": values = [address.country]; break;
    case "shippingFullAddress": values = [address.addressLine1]; break;
    case "total": values = [source.total, source.currency]; break;
    default: {
      const items = source.lineItems ?? source.items;
      if (!Array.isArray(items) || !items.length) return { text: "", reason: "missing" };
      const key = field === "quantity" ? "quantity" : "name";
      const valid = items.some(item => {
        const value = record(item)[key];
        return !valueReason(value) && (key !== "quantity" || /^\d+(?:\.\d+)?$/.test(String(value)));
      });
      if (!valid) return { text: "", reason: "invalid" };
      values = [];
    }
  }
  const reason = values.map(valueReason).find(Boolean);
  if (reason) return { text: "", reason };
  if (field === "total" && (!/^\d+(?:\.\d+)?$/.test(String(source.total)) || !/^[A-Z]{3}$/.test(String(source.currency)))) return { text: "", reason: "invalid" };
  if (field === "shippingFullAddress") {
    const parts = [address.addressLine1, address.addressLine2, address.city, address.state, address.postalCode, address.country]
      .filter(value => typeof value === "string").map(value => String(value).replace(/\s+/g, " ").trim()).filter(Boolean);
    return { text: [...new Set(parts)].join(locale.startsWith("ar") ? "، " : ", ") };
  }
  return { text: readOrderValue(order, field, locale).trim() };
}
function trimDecimal(value: string): string {
  const [integerPart, fractionPart] = value.split(".");
  if (!fractionPart) return integerPart;
  const trimmedFraction = fractionPart.replace(/0+$/, "");
  return trimmedFraction ? `${integerPart}.${trimmedFraction}` : integerPart;
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
        .map((item) => record(item).name)
        .filter(value => typeof value === "string" || typeof value === "number")
        .map(value => String(value).trim())
        .filter(Boolean)
        .join(", ");
    }
    case "quantity": {
      const items = (source.lineItems ?? source.items) as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(items)) return "";

      const quantities = items
        .map((item) => String(record(item).quantity ?? ""))
        .filter((quantity) => /^\d+(?:\.\d+)?$/.test(quantity));
      if (quantities.length === 0) return "";

      const scale = Math.max(
        ...quantities.map((quantity) => quantity.split(".")[1]?.length ?? 0),
      );
      const total = quantities.reduce((sum, quantity) => {
        const [integerPart, fractionPart = ""] = quantity.split(".");
        return sum + BigInt(`${integerPart}${fractionPart.padEnd(scale, "0")}`);
      }, 0n);
      const digits = total.toString().padStart(scale + 1, "0");
      if (scale === 0) return digits;
      return trimDecimal(`${digits.slice(0, -scale)}.${digits.slice(-scale)}`);
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
