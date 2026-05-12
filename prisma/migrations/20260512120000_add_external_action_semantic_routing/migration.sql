-- Add a pgvector-backed semantic routing index for chat-requested integration tools.
ALTER TABLE "public"."ExternalDataSource"
  ADD COLUMN "routingEmbedding" vector(768),
  ADD COLUMN "routingTextHash" TEXT,
  ADD COLUMN "routingIndexedAt" TIMESTAMP(3);

CREATE INDEX "ExternalDataSource_businessProfileId_trigger_isActive_idx"
  ON "public"."ExternalDataSource"("businessProfileId", "trigger", "isActive");

CREATE INDEX "ExternalDataSource_routingTextHash_idx"
  ON "public"."ExternalDataSource"("routingTextHash");
