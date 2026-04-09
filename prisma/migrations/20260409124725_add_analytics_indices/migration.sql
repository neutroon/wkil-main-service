-- CreateIndex
CREATE INDEX "ConversationMessage_status_createdAt_idx" ON "public"."ConversationMessage"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ConversationMessage_handoffCategory_idx" ON "public"."ConversationMessage"("handoffCategory");
