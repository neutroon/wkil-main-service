import { describe, expect, it } from "vitest";
import { applySimilarityThreshold } from "./similarityThreshold";

describe("applySimilarityThreshold", () => {
  it("drops rows below min similarity and caps topK", () => {
    const rows = [
      { similarity: 0.9, content: "a" },
      { similarity: 0.2, content: "b" },
      { similarity: 0.5, content: "c" },
      { similarity: 0.4, content: "d" },
    ];
    const out = applySimilarityThreshold(rows, 0.45, 2);
    expect(out.map((r) => r.content)).toEqual(["a", "c"]);
  });
});

