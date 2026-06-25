-- Admin-managed AI model registry.
-- Multi-provider ready (provider column) but only Google is wired into the runtime today.
-- API keys are intentionally NOT stored here; they remain in env/vault.
CREATE TABLE "AiModel" (
    "id" SERIAL NOT NULL,
    "modelId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'google',
    "category" TEXT NOT NULL DEFAULT 'chat',
    "tierOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "inputPrice" DECIMAL(12,6),
    "outputPrice" DECIMAL(12,6),
    "maxOutputTokens" INTEGER,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiModel_modelId_key" ON "AiModel"("modelId");

-- CreateIndex
CREATE INDEX "AiModel_provider_category_idx" ON "AiModel"("provider", "category");

-- CreateIndex
CREATE INDEX "AiModel_isActive_category_idx" ON "AiModel"("isActive", "category");
