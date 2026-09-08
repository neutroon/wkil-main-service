-- Support timestamp-safe keyset pagination for live and historical messages.
DROP INDEX IF EXISTS "ConversationMessage_conversationId_createdAt_idx";

CREATE INDEX "ConversationMessage_conversationId_createdAt_id_idx"
  ON "ConversationMessage"("conversationId", "createdAt", "id");
