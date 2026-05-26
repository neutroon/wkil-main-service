DROP INDEX IF EXISTS "public"."AgentActionSource_routingTextHash_idx";

ALTER TABLE "public"."AgentActionSource"
  DROP COLUMN IF EXISTS "routingMode",
  DROP COLUMN IF EXISTS "routerTimeoutMs",
  DROP COLUMN IF EXISTS "routingEmbedding",
  DROP COLUMN IF EXISTS "routingTextHash",
  DROP COLUMN IF EXISTS "routingIndexedAt";
