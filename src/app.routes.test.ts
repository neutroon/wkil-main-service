import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

describe("app route mounts", () => {
  const appSource = readFileSync(path.join(__dirname, "app.ts"), "utf8");

  it("mounts Agent Actions on the canonical API path only", () => {
    expect(appSource).toContain('app.use("/v1/agent-actions", agentActionRoutes)');
    expect(appSource).not.toContain("/v1/external-data");
  });
});
