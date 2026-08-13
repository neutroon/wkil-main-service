import { describe, expect, it } from "vitest";
import {
  normalizeCanonicalOrderEvent,
  normalizeE164Phone,
} from "./orderConfirmation.normalizer";

describe("normalizeE164Phone", () => {
  it("returns a valid E.164 phone unchanged", () => {
    expect(normalizeE164Phone("+201001234567")).toBe("+201001234567");
  });

  it("rejects local, formatted, and overlong phone numbers", () => {
    for (const phone of ["01001234567", "201001234567", "+20 1001234567", "+1234567890123456"]) {
      expect(() => normalizeE164Phone(phone), phone).toThrow();
    }
  });
});

describe("normalizeCanonicalOrderEvent", () => {
  it("normalizes decimal values, currency, and display strings", () => {
    const result = normalizeCanonicalOrderEvent({
      schemaVersion: "1",
      eventId: "evt_123",
      eventType: "order.created",
      occurredAt: "2026-08-13T10:30:00Z",
      order: {
        id: "ord_123",
        number: "  #123  ",
        currency: " egp ",
        total: 850,
        customer: {
          name: "  Mona  ",
          phone: "+201001234567",
          locale: "ar",
        },
        items: [
          {
            id: "sku_1",
            name: "  Product  ",
            quantity: "2",
            unitPrice: "425",
            total: "850.00",
          },
        ],
        shippingAddress: {
          city: "  Cairo  ",
          country: "  EG  ",
        },
      },
    });

    expect(result).toEqual({
      schemaVersion: "1",
      eventId: "evt_123",
      eventType: "order.created",
      occurredAt: "2026-08-13T10:30:00Z",
      order: {
        id: "ord_123",
        number: "#123",
        currency: "EGP",
        total: "850",
        customer: {
          name: "Mona",
          phone: "+201001234567",
          locale: "ar",
        },
        items: [
          {
            id: "sku_1",
            name: "Product",
            quantity: "2",
            unitPrice: "425",
            total: "850.00",
          },
        ],
        shippingAddress: {
          city: "Cairo",
          country: "EG",
        },
      },
    });
  });

  it("accepts decimal strings without converting them through floating point", () => {
    const result = normalizeCanonicalOrderEvent({
      schemaVersion: "1",
      eventId: "evt_123",
      eventType: "order.created",
      occurredAt: "2026-08-13T10:30:00Z",
      order: {
        id: "ord_123",
        number: "#123",
        currency: "USD",
        total: "9007199254740993.123456789",
        customer: {
          phone: "+14155552671",
        },
      },
    });

    expect(result.order.total).toBe("9007199254740993.123456789");
  });

  it("rejects exponent values that exceed the normalized decimal length limit", () => {
    expect(() =>
      normalizeCanonicalOrderEvent({
        schemaVersion: "1",
        eventId: "evt_123",
        eventType: "order.created",
        occurredAt: "2026-08-13T10:30:00Z",
        order: {
          id: "ord_123",
          number: "#123",
          currency: "USD",
          total: "1e1001",
          customer: {
            phone: "+14155552671",
          },
        },
      }),
    ).toThrow("Money and quantity values exceed the maximum decimal length");
  });

  it("rejects unsupported events and invalid locales", () => {
    expect(() =>
      normalizeCanonicalOrderEvent({
        schemaVersion: "1",
        eventId: "evt_123",
        eventType: "order.updated",
        occurredAt: "2026-08-13T10:30:00Z",
        order: {
          id: "ord_123",
          number: "#123",
          currency: "USD",
          total: 10,
          customer: {
            phone: "+14155552671",
            locale: "de",
          },
        },
      }),
    ).toThrow();
  });
});
