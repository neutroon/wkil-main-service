-- AlterTable
ALTER TABLE "public"."AiUsageStat" ADD COLUMN     "customerCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0;

-- AlterTable
ALTER TABLE "public"."BusinessProfile" ADD COLUMN     "monthlyTokensUsed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'FREE';

-- CreateTable
CREATE TABLE "public"."AiCallLog" (
    "id" TEXT NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "conversationId" TEXT,
    "modelName" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "completionTokens" INTEGER NOT NULL DEFAULT 0,
    "embeddingTokens" INTEGER NOT NULL DEFAULT 0,
    "groundingCalls" INTEGER NOT NULL DEFAULT 0,
    "systemCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "customerCost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BillingFailureLog" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "modelName" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "embeddingTokens" INTEGER,
    "groundingCalls" INTEGER,
    "error" TEXT NOT NULL,
    "operation" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingFailureLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiCallLog_businessProfileId_createdAt_idx" ON "public"."AiCallLog"("businessProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "AiCallLog_conversationId_idx" ON "public"."AiCallLog"("conversationId");

-- CreateIndex
CREATE INDEX "BillingFailureLog_businessProfileId_idx" ON "public"."BillingFailureLog"("businessProfileId");

-- CreateIndex
CREATE INDEX "BillingFailureLog_createdAt_idx" ON "public"."BillingFailureLog"("createdAt");

-- AddForeignKey
ALTER TABLE "public"."AiCallLog" ADD CONSTRAINT "AiCallLog_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BillingFailureLog" ADD CONSTRAINT "BillingFailureLog_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
