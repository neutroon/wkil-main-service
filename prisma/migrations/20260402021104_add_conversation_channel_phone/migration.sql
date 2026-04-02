-- AlterTable
ALTER TABLE "public"."Conversation" ADD COLUMN     "channel" TEXT,
ADD COLUMN     "customerPhone" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_channel_idx" ON "public"."Conversation"("channel");
