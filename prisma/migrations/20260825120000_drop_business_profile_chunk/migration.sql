-- Drop pgvector RAG table; chunks now live in Qdrant (owned by agent-svc).
DROP INDEX IF EXISTS "BusinessProfileChunk_businessProfileId_idx";
DROP INDEX IF EXISTS "BusinessProfileChunk_embedding_idx";
DROP TABLE IF EXISTS "BusinessProfileChunk";
