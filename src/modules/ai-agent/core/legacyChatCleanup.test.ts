import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = path.resolve(__dirname, "../..");
const runtimeDirs = [
  path.join(sourceRoot, "ai-agent", "chat"),
  path.join(sourceRoot, "ai-agent", "core"),
  path.join(sourceRoot, "ai-agent", "nodes"),
  path.join(sourceRoot, "widget"),
];

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
    return [fullPath];
  });
}

describe("legacy chat runtime cleanup", () => {
  it("keeps chat runtime off Gemini-native chat APIs and token streaming", () => {
    // The new `pipelineRuntime.ts` is the multi-provider abstraction that
    // legitimately needs `@google/genai` and `generateContentStream` (it
    // exposes them via `invokePipelineText` / `invokePipelineTextStream`).
    // This test is scoped to the chat-agent runtime — the modules that
    // build customer replies — not the shared pipeline layer.
    const ALLOWLIST = new Set([
      path.join(sourceRoot, "ai-agent", "core", "pipelineRuntime.ts"),
    ]);

    const files = runtimeDirs.flatMap(sourceFiles).filter((f) => !ALLOWLIST.has(f));
    const forbidden = [
      "@google/genai",
      "streamAgent",
      "computeBusinessChatStreaming",
      "dispatchCustomEvent(\"ai_token\"",
      "generateContentStream",
      "responseSchema",
      "functionDeclarations",
    ];

    const violations = files.flatMap((file) => {
      const text = fs.readFileSync(file, "utf8");
      return forbidden
        .filter((pattern) => text.includes(pattern))
        .map((pattern) => `${path.relative(sourceRoot, file)} contains ${pattern}`);
    });

    expect(violations).toEqual([]);
  });
});
