import { embedQuery, embedTexts } from "../config/gemini";
import { recordAiUsage } from "../services/billing.service";
import prisma from "../config/prisma";
import { logger } from "../utils/logger";
import { chunkBusinessProfile } from "./chunker";
import { CHUNK_TYPE_FIELDS } from "./chunkTypeFields";
import { applySimilarityThreshold } from "./similarityThreshold";

const DEFAULT_RAG_MIN_SIMILARITY = 0.25;
const MAX_CHUNK_CHARS = 2000;

function ragMinSimilarity(): number {
  const raw = process.env.RAG_MIN_SIMILARITY;
  if (raw === undefined || raw === "") return DEFAULT_RAG_MIN_SIMILARITY;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : DEFAULT_RAG_MIN_SIMILARITY;
}

function truncateChunkContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "…";
}

async function insertChunks(
  businessProfileId: number,
  chunks: { chunkType: string; chunkIndex: number; content: string }[],
  embeddings: number[][],
) {
  for (let i = 0; i < chunks.length; i++) {
    const { chunkType, chunkIndex, content } = chunks[i];
    const vector = `[${embeddings[i].join(",")}]`;
    await prisma.$executeRaw`
      INSERT INTO public."BusinessProfileChunk"
        ("businessProfileId", "content", "chunkType", "chunkIndex", "embedding", "createdAt", "updatedAt")
      VALUES
        (${businessProfileId}, ${content}, ${chunkType}, ${chunkIndex}, ${vector}::vector, NOW(), NOW())
    `;
  }
}

// ─── Full Ingest (on create + manual trigger) ────────────────────────────────
export async function ingestBusinessProfile(businessProfileId: number) {
  const profile = await prisma.businessProfile.findUniqueOrThrow({
    where: { id: businessProfileId },
    include: { faqs: true },
  });

  const chunks = chunkBusinessProfile(profile);
  const { embeddings, totalTokens } = await embedTexts(chunks.map((c) => c.content));

  // Log embedding usage
  recordAiUsage({
    businessProfileId,
    embeddingTokens: totalTokens,
    modelName: "gemini-embedding-001"
  }).catch(console.error);

  await prisma.businessProfileChunk.deleteMany({
    where: { businessProfileId },
  });
  await insertChunks(businessProfileId, chunks, embeddings);

  await prisma.businessProfile.update({
    where: { id: businessProfileId },
    data: { ragIngested: true, ragIngestedAt: new Date() },
  });

  console.log(
    `[RAG] Ingested ${chunks.length} chunks for profile ${businessProfileId}`,
  );
}

// ─── Partial Re-ingest (on update) ──────────────────────────────────────────
export async function partialReIngestBusinessProfile(
  businessProfileId: number,
  updatedFields: string[],
) {
  const affectedChunkTypes = Object.entries(CHUNK_TYPE_FIELDS)
    .filter(([_, fields]) => fields.some((f) => updatedFields.includes(f)))
    .map(([chunkType]) => chunkType);

  if (affectedChunkTypes.length === 0) {
    console.log(
      `[RAG] No RAG-relevant fields changed for profile ${businessProfileId}, skipping.`,
    );
    return;
  }

  const profile = await prisma.businessProfile.findUniqueOrThrow({
    where: { id: businessProfileId },
    include: { faqs: true },
  });

  const allChunks = chunkBusinessProfile(profile);
  const chunksToUpdate = allChunks.filter((c) =>
    affectedChunkTypes.includes(c.chunkType),
  );

  const { embeddings, totalTokens } = await embedTexts(chunksToUpdate.map((c) => c.content));

  // Log embedding usage
  recordAiUsage({
    businessProfileId,
    embeddingTokens: totalTokens,
    modelName: "gemini-embedding-001"
  }).catch(console.error);

  await prisma.businessProfileChunk.deleteMany({
    where: { businessProfileId, chunkType: { in: affectedChunkTypes } },
  });

  await insertChunks(businessProfileId, chunksToUpdate, embeddings);

  await prisma.businessProfile.update({
    where: { id: businessProfileId },
    data: { ragIngested: true, ragIngestedAt: new Date() },
  });

  console.log(
    `[RAG] Partially re-ingested ${chunksToUpdate.length} chunks (types: ${affectedChunkTypes.join(", ")}) for profile ${businessProfileId}`,
  );
}

export async function retrieveRelevantChunks(
  businessProfileId: number,
  query: string,
  topK: number = 5,
  options?: { minSimilarity?: number; fetchLimit?: number },
): Promise<{ chunkType: string; content: string; similarity: number }[]> {
  const minSimilarity = options?.minSimilarity ?? ragMinSimilarity();
  const fetchLimit =
    options?.fetchLimit ?? Math.min(50, Math.max(topK * 5, 15));

  // 1. Embed the user's query
  const { vector: queryEmbedding, totalTokens } = await embedQuery(query);
  const vector = `[${queryEmbedding.join(",")}]`;

  // Log retrieval embedding usage
  recordAiUsage({
    businessProfileId,
    embeddingTokens: totalTokens,
    modelName: "gemini-embedding-001"
  }).catch(console.error);

  // 2. Cosine similarity search via pgvector (fetch extra rows, then threshold)
  const chunks = await prisma.$queryRaw<
    { chunkType: string; content: string; similarity: number }[]
  >`
    SELECT "chunkType", "content",
    1 - (embedding <=> ${vector}::vector) AS similarity
    FROM public."BusinessProfileChunk"
    WHERE "businessProfileId" = ${businessProfileId}
    ORDER BY embedding <=> ${vector}::vector
    LIMIT ${fetchLimit}
  `;

  const filtered = applySimilarityThreshold(chunks, minSimilarity, topK).map(
    (c) => ({
      ...c,
      content: truncateChunkContent(c.content, MAX_CHUNK_CHARS),
    }),
  );

  logger.debug("rag.retrieve", {
    businessProfileId,
    rawCount: chunks.length,
    keptCount: filtered.length,
    minSimilarity,
    queryPreview: query.slice(0, 80),
  });

  return filtered;
}
