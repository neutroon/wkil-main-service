/*
  Warnings:

  - A unique constraint covering the columns `[businessProfileId,date,modelName]` on the table `AiUsageStat` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "public"."AiUsageStat_businessProfileId_date_key";

-- AlterTable
ALTER TABLE "public"."AiUsageStat" ADD COLUMN     "embeddingTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "groundingCalls" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "modelName" TEXT NOT NULL DEFAULT 'gemini-2.0-flash',
ADD COLUMN     "systemCost" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageStat_businessProfileId_date_modelName_key" ON "public"."AiUsageStat"("businessProfileId", "date", "modelName");
