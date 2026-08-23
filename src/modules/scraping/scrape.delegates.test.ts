import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

describe("scrape route delegates to service", () => {
  it("calls analyzeWebsiteForUser from the route", () => {
    const src = readFileSync(path.join(__dirname, "scrape.ts"), "utf8");
    expect(src).toContain("analyzeWebsiteForUser");
  });
});
