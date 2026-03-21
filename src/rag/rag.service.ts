import { embedQuery, embedTexts } from "../config/gemini";
import prisma from "../config/prisma";
import { chunkBusinessProfile } from "./chunker";
import { CHUNK_TYPE_FIELDS } from "./chunkTypeFields";

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
  const embeddings = await embedTexts(chunks.map((c) => c.content));

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

  const embeddings = await embedTexts(chunksToUpdate.map((c) => c.content));

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
): Promise<{ chunkType: string; content: string }[]> {
  // 1. Embed the user's query
  const queryEmbedding = await embedQuery(query);
  const vector = `[${queryEmbedding.join(",")}]`;

  // 2. Cosine similarity search via pgvector
  const chunks = await prisma.$queryRaw<
    { chunkType: string; content: string; similarity: number }[]
  >`
    SELECT "chunkType", "content",
    1 - (embedding <=> ${vector}::vector) AS similarity
    FROM public."BusinessProfileChunk"
    WHERE "businessProfileId" = ${businessProfileId}
    ORDER BY embedding <=> ${vector}::vector
    LIMIT ${topK}
  `;

  console.log(
    `[RAG] Retrieved ${chunks.length} chunks for query: "${query.slice(0, 50)}..."`,
  );

  return chunks;
}
