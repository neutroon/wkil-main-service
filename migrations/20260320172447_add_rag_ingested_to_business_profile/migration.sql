/*
  Warnings:

  - You are about to drop the column `faqs` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `ragIgested` on the `BusinessProfile` table. All the data in the column will be lost.
  - You are about to drop the column `scrapedRawMarkdown` on the `BusinessProfile` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "public"."BusinessProfileChunk_embedding_idx";

-- AlterTable
ALTER TABLE "public"."BusinessProfile" DROP COLUMN "faqs",
DROP COLUMN "ragIgested",
DROP COLUMN "scrapedRawMarkdown",
ADD COLUMN     "ragIngested" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "scrapedMarkdown" TEXT;

-- CreateTable
CREATE TABLE "public"."BusinessProfileFaq" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,

    CONSTRAINT "BusinessProfileFaq_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessProfileFaq_businessId_idx" ON "public"."BusinessProfileFaq"("businessId");

-- AddForeignKey
ALTER TABLE "public"."BusinessProfileFaq" ADD CONSTRAINT "BusinessProfileFaq_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
