import type {
  CanonicalOrderEvent,
  CanonicalOrderItem,
  CanonicalShippingAddress,
} from "./orderConfirmation.types";
import {
  parseCanonicalOrderEvent,
  parseRawCanonicalOrderEvent,
  type RawCanonicalOrderEvent,
} from "./orderConfirmation.validation";

const E164_PHONE_PATTERN = /^\+[1-9]\d{1,14}$/;
const DECIMAL_INPUT_PATTERN = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const MAX_EXPANDED_DECIMAL_LENGTH = 1_000;

export function normalizeE164Phone(phone: string): string {
  if (typeof phone !== "string" || !E164_PHONE_PATTERN.test(phone)) {
    throw new Error("Customer phone must be a valid E.164 phone number");
  }

  return phone;
}

function normalizeDecimal(value: string | number): string {
  const rawValue = typeof value === "number" ? String(value) : value.trim();

  if (!DECIMAL_INPUT_PATTERN.test(rawValue)) {
    throw new Error("Money and quantity values must be non-negative decimal values");
  }

  const exponentMatch = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(rawValue);
  const decimalValue = exponentMatch
    ? expandExponential(exponentMatch[1], exponentMatch[2] ?? "", Number(exponentMatch[3]))
    : rawValue;
  const [integerPart, fractionalPart] = decimalValue.split(".");
  const normalizedIntegerPart = integerPart.replace(/^0+(?=\d)/, "");

  return fractionalPart === undefined
    ? normalizedIntegerPart
    : `${normalizedIntegerPart}.${fractionalPart}`;
}

function expandExponential(integerPart: string, fractionalPart: string, exponent: number): string {
  const digits = `${integerPart}${fractionalPart}`;
  const decimalPosition = integerPart.length + exponent;
  const expandedLength =
    decimalPosition <= 0
      ? 2 - decimalPosition + digits.length
      : decimalPosition >= digits.length
        ? decimalPosition
        : digits.length + 1;

  if (!Number.isSafeInteger(expandedLength) || expandedLength > MAX_EXPANDED_DECIMAL_LENGTH) {
    throw new Error("Money and quantity values exceed the maximum decimal length");
  }

  if (decimalPosition <= 0) {
    return `0.${"0".repeat(-decimalPosition)}${digits}`;
  }

  if (decimalPosition >= digits.length) {
    return `${digits}${"0".repeat(decimalPosition - digits.length)}`;
  }

  return `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
}

function trimDisplay(value: string): string {
  return value.trim();
}

function normalizeItem(
  item: NonNullable<RawCanonicalOrderEvent["order"]["items"]>[number],
): CanonicalOrderItem {
  return {
    id: trimDisplay(item.id),
    name: trimDisplay(item.name),
    quantity: normalizeDecimal(item.quantity),
    unitPrice: normalizeDecimal(item.unitPrice),
    total: normalizeDecimal(item.total),
  };
}

function normalizeShippingAddress(
  address: NonNullable<RawCanonicalOrderEvent["order"]["shippingAddress"]>,
): CanonicalShippingAddress {
  return {
    ...(address.addressLine1 === undefined ? {} : { addressLine1: trimDisplay(address.addressLine1) }),
    ...(address.addressLine2 === undefined ? {} : { addressLine2: trimDisplay(address.addressLine2) }),
    ...(address.city === undefined ? {} : { city: trimDisplay(address.city) }),
    ...(address.state === undefined ? {} : { state: trimDisplay(address.state) }),
    ...(address.postalCode === undefined ? {} : { postalCode: trimDisplay(address.postalCode) }),
    ...(address.country === undefined ? {} : { country: trimDisplay(address.country) }),
  };
}

export function normalizeCanonicalOrderEvent(input: unknown): CanonicalOrderEvent {
  const raw = parseRawCanonicalOrderEvent(input);
  const order = raw.order;

  const normalized = {
    schemaVersion: raw.schemaVersion,
    eventId: trimDisplay(raw.eventId),
    eventType: raw.eventType,
    occurredAt: raw.occurredAt,
    order: {
      id: trimDisplay(order.id),
      number: trimDisplay(order.number),
      currency: order.currency.toUpperCase(),
      total: normalizeDecimal(order.total),
      customer: {
        ...(order.customer.name === undefined ? {} : { name: trimDisplay(order.customer.name) }),
        phone: normalizeE164Phone(order.customer.phone),
        ...(order.customer.locale === undefined ? {} : { locale: order.customer.locale }),
      },
      ...(order.items === undefined ? {} : { items: order.items.map(normalizeItem) }),
      ...(order.shippingAddress === undefined
        ? {}
        : { shippingAddress: normalizeShippingAddress(order.shippingAddress) }),
      ...(order.sourceStatus === undefined ? {} : { sourceStatus: trimDisplay(order.sourceStatus) }),
      ...(order.paymentMethod === undefined ? {} : { paymentMethod: trimDisplay(order.paymentMethod) }),
      ...(order.metadata === undefined ? {} : { metadata: order.metadata }),
    },
  };

  return parseCanonicalOrderEvent(normalized);
}
