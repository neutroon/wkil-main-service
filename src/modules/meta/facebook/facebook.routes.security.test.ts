import { describe, expect, it } from "vitest";

import facebookRoutes from "./facebook.routes";

describe("Facebook routes security", () => {
  it("does not expose the legacy message-id private reply route", () => {
    const paths = (facebookRoutes as any).stack
      .map((layer: any) => layer.route?.path)
      .filter(Boolean);

    expect(paths).not.toContain("/private-reply/:messageId");
  });
});
