import { embedQuery, embedTexts } from "../gemini";
import { recordAiUsage, assertQuotaAvailable } from "@modules/billing/billing.service";
import prisma, { Prisma } from "@config/prisma";
import { logger } from "@utils/logger";
import { chunkBusinessProfile } from "./chunker";
import { CHUNK_TYPE_FIELDS } from "./chunkTypeFields";
import { applySimilarityThreshold } from "./similarityThreshold";
import { env } from "@config/env";

const MAX_CHUNK_CHARS = 2000;
const CORE_CHUNK_TYPES = ["identity", "contact", "intents"];
const KEYWORD_FETCH_LIMIT = 200;
const STRONG_KEYWORD_SCORE_THRESHOLD = 0.25;

type RetrievedChunk = {
  id?: number;
  chunkType: string;
  content: string;
  similarity: number;
  lexicalScore?: number;
};

type ChunkRow = {
  id: number;
  chunkType: string;
  content: string;
};

export type PublicRetrievedChunk = {
  chunkType: string;
  content: string;
  similarity: number;
};

export function getRagSimilarityThreshold(): number {
  return env.RAG_MIN_SIMILARITY;
}

function truncateChunkContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars) + "…";
}

function tokenizeForKeywordSearch(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .map((term) => term.trim())
        .filter((term) => term.length >= 2),
    ),
  ).slice(0, 12);
}

function scoreKeywordMatch(content: string, terms: string[]): number {
  if (terms.length === 0) return 0;

  const lowerContent = content.toLowerCase();
  const matches = terms.filter((term) => lowerContent.includes(term)).length;
  return matches / terms.length;
}

function hasStrongKeywordEvidence(chunks: RetrievedChunk[]): boolean {
  return chunks.some(
    (chunk) =>
      !CORE_CHUNK_TYPES.includes(chunk.chunkType) &&
      (chunk.lexicalScore ?? 0) >= STRONG_KEYWORD_SCORE_THRESHOLD,
  );
}

function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}

async function fetchKeywordCandidates(
  businessProfileId: number,
  keywordTerms: string[],
): Promise<ChunkRow[]> {
  if (keywordTerms.length === 0) return [];

  const clauses = Prisma.join(
    keywordTerms.map((term) => {
      const pattern = `%${escapeLikePattern(term)}%`;
      return Prisma.sql`"content" ILIKE ${pattern} ESCAPE '\\'`;
    }),
    " OR ",
  );

  return prisma.$queryRaw<ChunkRow[]>`
    SELECT "id", "chunkType", "content"
    FROM public."BusinessProfileChunk"
    WHERE "businessProfileId" = ${businessProfileId}
      AND (${clauses})
    ORDER BY "chunkIndex" ASC
    LIMIT ${KEYWORD_FETCH_LIMIT}
  `;
}

function remainingDeadlineMs(deadlineAt?: number): number | undefined {
  if (!deadlineAt) return undefined;
  return Math.max(0, deadlineAt - Date.now());
}

async function withRagDeadline<T>(params: {
  operation: () => Promise<T>;
  fallback: T;
  deadlineAt?: number;
  businessProfileId: number;
  label: string;
  configuredTimeoutMs?: number;
}): Promise<T> {
  const remainingMs = remainingDeadlineMs(params.deadlineAt);
  if (remainingMs === undefined) return params.operation();
  if (remainingMs <= 0) {
    logger.warn("rag.retrieve.step_timeout", {
      businessProfileId: params.businessProfileId,
      label: params.label,
      timeoutMs: params.configuredTimeoutMs,
      remainingMs,
    });
    return params.fallback;
  }

  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeout = setTimeout(() => {
      logger.warn("rag.retrieve.step_timeout", {
        businessProfileId: params.businessProfileId,
        label: params.label,
        timeoutMs: params.configuredTimeoutMs,
        remainingMs,
      });
      resolve(params.fallback);
    }, remainingMs);
  });

  try {
    return await Promise.race([params.operation(), timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function mergeRankedChunks(
  vectorChunks: RetrievedChunk[],
  keywordChunks: RetrievedChunk[],
  coreChunks: RetrievedChunk[],
  topK: number,
): RetrievedChunk[] {
  const merged = new Map<string, RetrievedChunk>();

  for (const chunk of [...coreChunks, ...vectorChunks, ...keywordChunks]) {
    const key = chunk.id ? String(chunk.id) : `${chunk.chunkType}:${chunk.content}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, chunk);
      continue;
    }

    merged.set(key, {
      ...existing,
      similarity: Math.max(existing.similarity, chunk.similarity),
      lexicalScore: Math.max(existing.lexicalScore ?? 0, chunk.lexicalScore ?? 0),
    });
  }

  const coreKeys = new Set(
    coreChunks.map((chunk) =>
      chunk.id ? String(chunk.id) : `${chunk.chunkType}:${chunk.content}`,
    ),
  );
  const core = Array.from(merged.entries())
    .filter(([key]) => coreKeys.has(key))
    .map(([, chunk]) => chunk);
  const ranked = Array.from(merged.entries())
    .filter(([key]) => !coreKeys.has(key))
    .map(([, chunk]) => chunk)
    .sort(
      (a, b) =>
        Math.max(b.similarity, b.lexicalScore ?? 0) -
        Math.max(a.similarity, a.lexicalScore ?? 0),
    )
    .slice(0, topK);

  return [...core, ...ranked];
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
    include: { faqs: true, knowledgeSections: true },
  });

  // Pre-flight quota check
  await assertQuotaAvailable(profile.userId, businessProfileId);

  const chunks = chunkBusinessProfile(profile);
  const { embeddings, totalTokens } = await embedTexts(chunks.map((c) => c.content));

  // Log embedding usage
  recordAiUsage({
    userId: profile.userId,
    businessProfileId,
    embeddingTokens: totalTokens,
    modelName: "gemini-embedding-001",
    operation: "rag_ingest_full",
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
  const profile = await prisma.businessProfile.findUniqueOrThrow({
    where: { id: businessProfileId },
    include: { faqs: true, knowledgeSections: true },
  });

  // Pre-flight quota check
  await assertQuotaAvailable(profile.userId, businessProfileId);

  const affectedChunkTypes = Object.entries(CHUNK_TYPE_FIELDS)
    .filter(([_, fields]) => fields.some((f) => updatedFields.includes(f)))
    .map(([chunkType]) => chunkType);

  if (affectedChunkTypes.length === 0) {
    console.log(
      `[RAG] No RAG-relevant fields changed for profile ${businessProfileId}, skipping.`,
    );
    return;
  }

  const allChunks = chunkBusinessProfile(profile);
  const chunksToUpdate = allChunks.filter((c) =>
    affectedChunkTypes.includes(c.chunkType),
  );

  const { embeddings, totalTokens } = await embedTexts(chunksToUpdate.map((c) => c.content));

  // Log embedding usage
  recordAiUsage({
    userId: profile.userId,
    businessProfileId,
    embeddingTokens: totalTokens,
    modelName: "gemini-embedding-001",
    operation: "rag_ingest_partial",
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
  options?: {
    minSimilarity?: number;
    fetchLimit?: number;
    userId?: number;
    timeoutMs?: number;
  },
): Promise<PublicRetrievedChunk[]> {
  const result = await retrieveRelevantChunksWithEmbedding(
    businessProfileId,
    query,
    topK,
    options,
  );
  return result.chunks;
}

export async function retrieveRelevantChunksWithEmbedding(
  businessProfileId: number,
  query: string,
  topK: number = 5,
  options?: {
    minSimilarity?: number;
    fetchLimit?: number;
    userId?: number;
    timeoutMs?: number;
  },
): Promise<{ chunks: PublicRetrievedChunk[]; queryEmbedding: number[] | null }> {
  const minSimilarity = options?.minSimilarity ?? getRagSimilarityThreshold();
  const fetchLimit =
    options?.fetchLimit ?? Math.min(50, Math.max(topK * 5, 15));
  const deadlineAt = options?.timeoutMs ? Date.now() + options.timeoutMs : undefined;

  // If the query is empty but we're in a multimodal context, return identity
  // chunks so the AI still knows which business it represents.
  if (!query || query.trim().length === 0) {
    logger.debug("rag.retrieve.empty_query_using_identity", { businessProfileId });
    return {
      chunks: await withRagDeadline({
        operation: () => getIdentityContext(businessProfileId),
        fallback: [],
        deadlineAt,
        businessProfileId,
        label: "identity_context",
        configuredTimeoutMs: options?.timeoutMs,
      }),
      queryEmbedding: null,
    };
  }

  const keywordTerms = tokenizeForKeywordSearch(query);
  const keywordCandidatesPromise = withRagDeadline<ChunkRow[]>({
    operation: () => fetchKeywordCandidates(businessProfileId, keywordTerms),
    fallback: [],
    deadlineAt,
    businessProfileId,
    label: "keyword_candidates",
    configuredTimeoutMs: options?.timeoutMs,
  });
  const coreChunksPromise = withRagDeadline<ChunkRow[]>({
    operation: () => prisma.businessProfileChunk.findMany({
      where: {
        businessProfileId,
        chunkType: { in: CORE_CHUNK_TYPES },
      },
      select: { id: true, chunkType: true, content: true },
      orderBy: { chunkIndex: "asc" },
      take: 5,
    }),
    fallback: [],
    deadlineAt,
    businessProfileId,
    label: "core_chunks",
    configuredTimeoutMs: options?.timeoutMs,
  });
  const profilePromise = options?.userId
    ? Promise.resolve({ userId: options.userId })
    : withRagDeadline<{ userId: number } | null>({
        operation: () => prisma.businessProfile.findUnique({
          where: { id: businessProfileId },
          select: { userId: true },
        }),
        fallback: null,
        deadlineAt,
        businessProfileId,
        label: "profile_lookup",
        configuredTimeoutMs: options?.timeoutMs,
      });
  const [profile, keywordCandidates, coreChunks] = await Promise.all([
    profilePromise,
    keywordCandidatesPromise,
    coreChunksPromise,
  ]);

  if (!profile) return { chunks: [], queryEmbedding: null };

  // Pre-flight quota check
  const quotaChecked = await withRagDeadline({
    operation: async () => {
      await assertQuotaAvailable(profile.userId, businessProfileId);
      return true;
    },
    fallback: false,
    deadlineAt,
    businessProfileId,
    label: "quota_check",
    configuredTimeoutMs: options?.timeoutMs,
  });
  if (!quotaChecked) {
    logger.warn("rag.retrieve.quota_check_deferred", {
      businessProfileId,
      timeoutMs: options?.timeoutMs,
    });
  }

  const keywordChunks = keywordCandidates
    .map((chunk) => ({
      ...chunk,
      similarity: 0,
      lexicalScore: scoreKeywordMatch(chunk.content, keywordTerms),
    }))
    .filter((chunk) => (chunk.lexicalScore ?? 0) > 0)
    .sort((a, b) => (b.lexicalScore ?? 0) - (a.lexicalScore ?? 0))
    .slice(0, topK);

  const coreContext = coreChunks.map((chunk) => ({
    ...chunk,
    similarity: 1,
    lexicalScore: 1,
  }));

  let queryEmbedding: number[] | null = null;
  let vectorChunks: RetrievedChunk[] = [];

  const shouldUseVectorSearch =
    keywordTerms.length >= 2 &&
    !hasStrongKeywordEvidence(keywordChunks) &&
    (remainingDeadlineMs(deadlineAt) ?? 1) > 0;

  if (shouldUseVectorSearch) {
    const embeddingResult = await withRagDeadline({
      operation: () => embedQuery(query, {
        timeoutMs: remainingDeadlineMs(deadlineAt) ?? options?.timeoutMs,
      })
        .then((result) => ({ ok: true as const, result }))
        .catch((error) => ({ ok: false as const, error })),
      fallback: { ok: false as const, error: new Error("RAG_RETRIEVAL_TIMEOUT") },
      deadlineAt,
      businessProfileId,
      label: "query_embedding",
      configuredTimeoutMs: options?.timeoutMs,
    });

    if (!embeddingResult.ok) {
      logger.warn("rag.retrieve.embedding_fallback_to_lexical", {
        businessProfileId,
        timeoutMs: options?.timeoutMs,
        error:
          embeddingResult.error instanceof Error
            ? embeddingResult.error.message
            : String(embeddingResult.error),
        queryPreview: query.slice(0, 80),
      });
    } else {
      const { vector: embeddedQuery, totalTokens } = embeddingResult.result;
      queryEmbedding = embeddedQuery;
      const vector = `[${queryEmbedding.join(",")}]`;

      // Log retrieval embedding usage
      recordAiUsage({
        userId: profile.userId,
        businessProfileId,
        embeddingTokens: totalTokens,
        modelName: "gemini-embedding-001",
        operation: "rag_retrieve",
      }).catch(console.error);

      // Cosine similarity search via pgvector (fetch extra rows, then threshold)
      vectorChunks = await withRagDeadline<RetrievedChunk[]>({
        operation: () => prisma.$queryRaw<RetrievedChunk[]>`
          SELECT "id", "chunkType", "content",
          1 - (embedding <=> ${vector}::vector) AS similarity
          FROM public."BusinessProfileChunk"
          WHERE "businessProfileId" = ${businessProfileId}
          ORDER BY embedding <=> ${vector}::vector
          LIMIT ${fetchLimit}
        `,
        fallback: [],
        deadlineAt,
        businessProfileId,
        label: "vector_search",
        configuredTimeoutMs: options?.timeoutMs,
      });
    }
  }

  const filteredVectorChunks = applySimilarityThreshold(
    vectorChunks,
    minSimilarity,
    topK,
  );
  const filtered = mergeRankedChunks(
    filteredVectorChunks,
    keywordChunks,
    coreContext,
    topK,
  ).map((c) => ({
    ...c,
    content: truncateChunkContent(c.content, MAX_CHUNK_CHARS),
  }));

  const evidenceCount = filtered.filter(
    (chunk) => !CORE_CHUNK_TYPES.includes(chunk.chunkType),
  ).length;

  if (evidenceCount === 0) {
    logger.warn("rag.retrieve.no_specific_evidence", {
      businessProfileId,
      minSimilarity,
      queryPreview: query.slice(0, 80),
    });
  }

  const publicChunks = filtered.map(
    ({ chunkType, content, similarity }) => ({
      chunkType,
      content,
      similarity,
    }),
  );

  logger.debug("rag.retrieve", {
    businessProfileId,
    vectorRawCount: vectorChunks.length,
    keywordCount: keywordChunks.length,
    coreCount: coreContext.length,
    keptCount: publicChunks.length,
    minSimilarity,
    queryPreview: query.slice(0, 80),
    retrievedChunks: publicChunks.map(c => ({
      type: c.chunkType,
      similarity: c.similarity.toFixed(3),
      contentSnippet: c.content.slice(0, 50).replace(/\n/g, ' ')
    }))
  });

  return { chunks: publicChunks, queryEmbedding };
}

/**
 * Fetches the core business identity chunks (identity, voice, tone, mission).
 * Used as a fallback when the user sends media (image/audio) without text.
 */
export async function getIdentityContext(businessProfileId: number): Promise<{ chunkType: string; content: string; similarity: number }[]> {
  try {
     const chunks = await prisma.businessProfileChunk.findMany({
        where: { 
          businessProfileId, 
          chunkType: { in: ["identity", "product", "contact", "faq", "intents"] } 
        },
        take: 5,
        orderBy: { createdAt: "asc" }
     });

     return chunks.map(c => ({
        chunkType: c.chunkType,
        content: c.content,
        similarity: 1.0 // Identity chunks are always considered relevant fallbacks
     }));
  } catch (error) {
     logger.error("rag.identity_fetch_failed", { businessProfileId, error: String(error) });
     return [];
  }
}




