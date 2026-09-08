-- Support timestamp-safe keyset pagination for live and historical messages.
CREATE INDEX "ConversationMessage_conversationId_createdAt_id_idx"
  ON "ConversationMessage"("conversationId", "createdAt", "id");
