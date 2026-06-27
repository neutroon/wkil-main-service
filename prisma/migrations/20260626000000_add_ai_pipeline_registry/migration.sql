-- Per-pipeline AI configuration override.
-- One row per AI surface (chat, follow_up, content, image_gen, embeddings, ...).
-- `inheritsChatDefault = true` makes a pipeline follow the chat model selection;
-- `false` lets it use its own `modelIds` for per-surface cost/quality control.
-- `modelClass` gates which AiModel categories are selectable per pipeline.
CREATE TABLE "AiPipeline" (
    "id" SERIAL NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "modelClass" TEXT NOT NULL DEFAULT 'text',
    "modelIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "temperature" DOUBLE PRECISION,
    "maxOutputTokens" INTEGER,
    "timeoutMs" INTEGER,
    "inheritsChatDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiPipeline_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiPipeline_key_key" ON "AiPipeline"("key");

-- CreateIndex
CREATE INDEX "AiPipeline_modelClass_idx" ON "AiPipeline"("modelClass");
