import { describe, expect, it } from "vitest";
import {
  isWhatsAppOptOut,
  normalizeOptOutText,
  parseWhatsAppInteractiveReply,
} from "./orderConfirmation.whatsapp.parser";

describe("parseWhatsAppInteractiveReply", () => {
  it("returns the opaque button ID and title", () => {
    expect(
      parseWhatsAppInteractiveReply({
        type: "interactive",
        interactive: {
          type: "button_reply",
          button_reply: {
            id: "opaque-action-token/with.dots",
            title: "Confirm order",
          },
        },
      }),
    ).toEqual({
      actionToken: "opaque-action-token/with.dots",
      buttonTitle: "Confirm order",
    });
  });

  it("does not parse a button reply without an ID", () => {
    expect(
      parseWhatsAppInteractiveReply({
        interactive: { button_reply: { title: "Confirm order" } },
      }),
    ).toBeNull();
  });

  it("ignores non-interactive text messages", () => {
    expect(
      parseWhatsAppInteractiveReply({ type: "text", text: { body: "stop" } }),
    ).toBeNull();
  });

  it("omits a missing button title without changing the opaque ID", () => {
    expect(
      parseWhatsAppInteractiveReply({
        interactive: { button_reply: { id: "opaque-id" } },
      }),
    ).toEqual({ actionToken: "opaque-id" });
  });
});

describe("WhatsApp opt-out matching", () => {
  it.each([
    ["stop", "stop"],
    ["  STOP!!! ", "stop"],
    ["unsubscribe", "unsubscribe"],
    ["stop all", "stop all"],
    ["unsubscribe me", "unsubscribe me"],
    ["do not message", "do not message"],
    ["don't message", "don t message"],
    ["وقف", "وقف"],
    ["وقف الرسائل", "وقف الرسائل"],
    ["لا تراسل", "لا تراسل"],
    ["الغاء،", "الغاء"],
    ["إلغاء الاشتراك", "إلغاء الاشتراك"],
  ])("normalizes %j to %j", (input, expected) => {
    expect(normalizeOptOutText(input)).toBe(expected);
    expect(isWhatsAppOptOut(input)).toBe(true);
  });

  it.each([
    "cancel",
    "please cancel my order",
    "stop order",
    "unsubscribe my order",
    "وقف الطلب",
    "hello there",
  ])("does not treat %j as a global opt-out", (input) => {
    expect(isWhatsAppOptOut(input)).toBe(false);
  });
});
