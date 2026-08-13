import { describe, expect, it } from "vitest";
import { parseCanonicalOrderEvent } from "./orderConfirmation.validation";

const minimumCanonicalEvent = {
  schemaVersion: "1",
  eventId: "evt_123",
  eventType: "order.created",
  occurredAt: "2026-08-13T10:30:00Z",
  order: {
    id: "ord_123",
    number: "#123",
    currency: "EGP",
    total: "850.00",
    customer: {
      phone: "+201001234567",
    },
  },
};

describe("parseCanonicalOrderEvent", () => {
  it("accepts the minimum canonical order.created event", () => {
    expect(parseCanonicalOrderEvent(minimumCanonicalEvent)).toEqual(minimumCanonicalEvent);
  });

  it("accepts optional locale, items, shipping address, and metadata", () => {
    const event = {
      ...minimumCanonicalEvent,
      order: {
        ...minimumCanonicalEvent.order,
        customer: {
          ...minimumCanonicalEvent.order.customer,
          name: "Mona",
          locale: "ar",
        },
        items: [
          {
            id: "sku_1",
            name: "Product",
            quantity: "2",
            unitPrice: "425.00",
            total: "850.00",
          },
        ],
        shippingAddress: {
          city: "Cairo",
          country: "EG",
        },
        metadata: {
          provider: "generic",
        },
      },
    };

    expect(parseCanonicalOrderEvent(event)).toEqual(event);
  });

  it("rejects a missing customer phone", () => {
    const event = {
      ...minimumCanonicalEvent,
      order: {
        ...minimumCanonicalEvent.order,
        customer: {},
      },
    };

    expect(() => parseCanonicalOrderEvent(event)).toThrow();
  });

  it("rejects a non-E.164 customer phone instead of guessing a country code", () => {
    const event = {
      ...minimumCanonicalEvent,
      order: {
        ...minimumCanonicalEvent.order,
        customer: { phone: "01001234567" },
      },
    };

    expect(() => parseCanonicalOrderEvent(event)).toThrow();
  });

  it("rejects unsupported event types", () => {
    const event = {
      ...minimumCanonicalEvent,
      eventType: "order.updated",
    };

    expect(() => parseCanonicalOrderEvent(event)).toThrow();
  });

  it("rejects invalid event IDs, order IDs, dates, currencies, and totals", () => {
    expect(() =>
      parseCanonicalOrderEvent({
        ...minimumCanonicalEvent,
        eventId: "",
      }),
    ).toThrow();

    expect(() =>
      parseCanonicalOrderEvent({
        ...minimumCanonicalEvent,
        order: {
          ...minimumCanonicalEvent.order,
          id: "",
        },
      }),
    ).toThrow();

    expect(() =>
      parseCanonicalOrderEvent({
        ...minimumCanonicalEvent,
        occurredAt: "not-an-iso-date",
      }),
    ).toThrow();

    expect(() =>
      parseCanonicalOrderEvent({
        ...minimumCanonicalEvent,
        order: {
          ...minimumCanonicalEvent.order,
          currency: "EG",
        },
      }),
    ).toThrow();

    expect(() =>
      parseCanonicalOrderEvent({
        ...minimumCanonicalEvent,
        order: {
          ...minimumCanonicalEvent.order,
          total: "850.2.1",
        },
      }),
    ).toThrow();
  });

  it("rejects locales other than Arabic and English", () => {
    const event = {
      ...minimumCanonicalEvent,
      order: {
        ...minimumCanonicalEvent.order,
        customer: {
          phone: "+201001234567",
          locale: "fr",
        },
      },
    };

    expect(() => parseCanonicalOrderEvent(event)).toThrow();
  });
});
