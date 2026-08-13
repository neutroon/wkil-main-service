import { z } from "zod";
import type { CanonicalOrderEvent } from "./orderConfirmation.types";

const E164_PHONE_PATTERN = /^\+[1-9]\d{1,14}$/;
const DECIMAL_STRING_PATTERN = /^\d+(?:\.\d+)?$/;
const ISO_CURRENCY_PATTERN = /^[A-Z]{3}$/;

const nonBlankString = z.string().refine((value) => value.trim().length > 0, {
  message: "must not be blank",
});

const decimalStringSchema = z.string().regex(DECIMAL_STRING_PATTERN, "must be a decimal string");
const phoneSchema = z.string().regex(E164_PHONE_PATTERN, "must be an E.164 phone number");
const localeSchema = z.enum(["ar", "en"]);
const currencySchema = z.string().regex(ISO_CURRENCY_PATTERN, "must be an ISO 4217 currency code");
const occurredAtSchema = z.string().datetime({ offset: true });
const metadataSchema = z.record(z.string(), z.unknown());

const canonicalOrderCustomerSchema = z
  .object({
    name: nonBlankString.optional(),
    phone: phoneSchema,
    locale: localeSchema.optional(),
  })
  .strict();

const canonicalOrderItemSchema = z
  .object({
    id: nonBlankString,
    name: nonBlankString,
    quantity: decimalStringSchema,
    unitPrice: decimalStringSchema,
    total: decimalStringSchema,
  })
  .strict();

const canonicalShippingAddressSchema = z
  .object({
    addressLine1: nonBlankString.optional(),
    addressLine2: nonBlankString.optional(),
    city: nonBlankString.optional(),
    state: nonBlankString.optional(),
    postalCode: nonBlankString.optional(),
    country: nonBlankString.optional(),
  })
  .strict();

const canonicalOrderSchema = z
  .object({
    id: nonBlankString,
    number: nonBlankString,
    currency: currencySchema,
    total: decimalStringSchema,
    customer: canonicalOrderCustomerSchema,
    items: z.array(canonicalOrderItemSchema).optional(),
    shippingAddress: canonicalShippingAddressSchema.optional(),
    sourceStatus: nonBlankString.optional(),
    paymentMethod: nonBlankString.optional(),
    metadata: metadataSchema.optional(),
  })
  .strict();

export const canonicalOrderEventSchema = z
  .object({
    schemaVersion: z.literal("1"),
    eventId: nonBlankString,
    eventType: z.literal("order.created"),
    occurredAt: occurredAtSchema,
    order: canonicalOrderSchema,
  })
  .strict();

const decimalInputSchema = z.union([
  z.string().min(1),
  z.number().refine(Number.isFinite, "must be a finite number"),
]);

const rawOrderEventSchema = z
  .object({
    schemaVersion: z.literal("1"),
    eventId: nonBlankString,
    eventType: z.literal("order.created"),
    occurredAt: occurredAtSchema,
    order: z
      .object({
        id: nonBlankString,
        number: nonBlankString,
        currency: z.string().trim().regex(/^[A-Za-z]{3}$/, "must be an ISO 4217 currency code"),
        total: decimalInputSchema,
        customer: z
          .object({
            name: nonBlankString.optional(),
            phone: phoneSchema,
            locale: localeSchema.optional(),
          })
          .strict(),
        items: z
          .array(
            z
              .object({
                id: nonBlankString,
                name: nonBlankString,
                quantity: decimalInputSchema,
                unitPrice: decimalInputSchema,
                total: decimalInputSchema,
              })
              .strict(),
          )
          .optional(),
        shippingAddress: z
          .object({
            addressLine1: nonBlankString.optional(),
            addressLine2: nonBlankString.optional(),
            city: nonBlankString.optional(),
            state: nonBlankString.optional(),
            postalCode: nonBlankString.optional(),
            country: nonBlankString.optional(),
          })
          .strict()
          .optional(),
        sourceStatus: nonBlankString.optional(),
        paymentMethod: nonBlankString.optional(),
        metadata: metadataSchema.optional(),
      })
      .strict(),
  })
  .strict();

export type RawCanonicalOrderEvent = z.infer<typeof rawOrderEventSchema>;

export function parseCanonicalOrderEvent(input: unknown): CanonicalOrderEvent {
  return canonicalOrderEventSchema.parse(input) as CanonicalOrderEvent;
}

export function parseRawCanonicalOrderEvent(input: unknown): RawCanonicalOrderEvent {
  return rawOrderEventSchema.parse(input);
}

export { E164_PHONE_PATTERN, DECIMAL_STRING_PATTERN, currencySchema };
