-- AlterTable
ALTER TABLE "public"."ConversationMessage" ADD COLUMN     "externalId" TEXT;

-- CreateIndex
CREATE INDEX "ConversationMessage_externalId_idx" ON "public"."ConversationMessage"("externalId");
