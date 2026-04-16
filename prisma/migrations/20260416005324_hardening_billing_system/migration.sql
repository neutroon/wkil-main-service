/*
  Warnings:

  - A unique constraint covering the columns `[userId,businessProfileId,date,modelName]` on the table `AiUsageStat` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `userId` to the `AiCallLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `AiUsageStat` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `BillingFailureLog` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "public"."AiUsageStat_businessProfileId_date_modelName_key";

-- AlterTable
ALTER TABLE "public"."AiCallLog" ADD COLUMN     "userId" INTEGER NOT NULL,
ALTER COLUMN "businessProfileId" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."AiUsageStat" ADD COLUMN     "userId" INTEGER NOT NULL,
ALTER COLUMN "businessProfileId" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."BillingFailureLog" ADD COLUMN     "userId" INTEGER NOT NULL,
ALTER COLUMN "businessProfileId" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "autoResetEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "monthlyQuota" INTEGER,
ADD COLUMN     "monthlyTokensUsed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "plan" TEXT NOT NULL DEFAULT 'FREE';

-- CreateIndex
CREATE INDEX "AiCallLog_userId_createdAt_idx" ON "public"."AiCallLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AiUsageStat_userId_idx" ON "public"."AiUsageStat"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "AiUsageStat_userId_businessProfileId_date_modelName_key" ON "public"."AiUsageStat"("userId", "businessProfileId", "date", "modelName");

-- CreateIndex
CREATE INDEX "BillingFailureLog_userId_idx" ON "public"."BillingFailureLog"("userId");

-- AddForeignKey
ALTER TABLE "public"."AiUsageStat" ADD CONSTRAINT "AiUsageStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AiCallLog" ADD CONSTRAINT "AiCallLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BillingFailureLog" ADD CONSTRAINT "BillingFailureLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
