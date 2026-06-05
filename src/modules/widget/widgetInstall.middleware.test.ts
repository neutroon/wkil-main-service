import { describe, expect, it } from "vitest";
import { parseAllowedOrigins } from "./widgetInstall.middleware";

describe("parseAllowedOrigins", () => {
  it("normalizes array values to exact origins and removes duplicates", () => {
    expect(
      parseAllowedOrigins([
        "https://shop.example/path",
        "shop.example",
        "http://localhost:3000/demo",
        "mailto:support@example.com",
        "",
      ]),
    ).toEqual(["https://shop.example", "http://localhost:3000"]);
  });

  it("accepts comma and newline separated origin strings", () => {
    expect(
      parseAllowedOrigins("https://www.wkil.app/ar, wkil.app\n*"),
    ).toEqual(["https://www.wkil.app", "https://wkil.app", "*"]);
  });
});
