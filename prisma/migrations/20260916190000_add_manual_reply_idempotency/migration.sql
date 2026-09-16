-- Durable claim for user-initiated Messenger and Facebook-comment replies.
ALTER TABLE "ConversationMessage"
ADD COLUMN "manualReplyIdempotencyKey" TEXT,
ADD COLUMN "manualReplyRequestHash" TEXT;

CREATE UNIQUE INDEX "ConversationMessage_conversationId_manualReplyIdempotencyKey_key"
ON "ConversationMessage"("conversationId", "manualReplyIdempotencyKey");
