import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { PIPELINE_KEYS } from "./ai-pipeline.service";

describe("copilot pipeline key", () => {
  it("is registered in PIPELINE_KEYS", () => {
    expect(PIPELINE_KEYS).toContain("copilot");
  });

  it("is seeded with chat-tier inheritance", () => {
    const seed = readFileSync(path.join(__dirname, "../../../../prisma/seed-ai-pipelines.ts"), "utf8");
    expect(seed).toContain('key: "copilot"');
    expect(seed).toMatch(/key: "copilot"[\s\S]*?inheritsChatDefault: true/);
  });
});
