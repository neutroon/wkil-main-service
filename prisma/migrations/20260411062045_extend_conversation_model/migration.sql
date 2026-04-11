/*
  Warnings:

  - A unique constraint covering the columns `[externalId]` on the table `Conversation` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."BusinessProfile" ADD COLUMN     "facebookGreetingMode" TEXT NOT NULL DEFAULT 'AI',
ADD COLUMN     "facebookGreetingTemplate" TEXT NOT NULL DEFAULT 'Thanks {{name}}! I''ve sent the full details to your inbox.';

-- AlterTable
ALTER TABLE "public"."Conversation" ADD COLUMN     "externalId" TEXT,
ADD COLUMN     "parentConversationId" INTEGER,
ADD COLUMN     "postId" TEXT,
ADD COLUMN     "processingStatus" TEXT NOT NULL DEFAULT 'COMPLETED';

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_externalId_key" ON "public"."Conversation"("externalId");

-- CreateIndex
CREATE INDEX "Conversation_externalId_idx" ON "public"."Conversation"("externalId");

-- CreateIndex
CREATE INDEX "Conversation_postId_idx" ON "public"."Conversation"("postId");

-- AddForeignKey
ALTER TABLE "public"."Conversation" ADD CONSTRAINT "Conversation_parentConversationId_fkey" FOREIGN KEY ("parentConversationId") REFERENCES "public"."Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
