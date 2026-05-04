/** Filter vector hits by cosine-similarity floor and cap result size. */
export function applySimilarityThreshold<T extends { similarity: number }>(
  chunks: T[],
  minSimilarity: number,
  topK: number,
): T[] {
  return chunks
    .filter((c) => c.similarity >= minSimilarity)
    .slice(0, topK);
}

