ALTER TYPE "AgentTurnMode" ADD VALUE IF NOT EXISTS 'FOLLOW_UP';
ALTER TABLE "Conversation" ADD COLUMN "agentThreadId" UUID;
ALTER TABLE "Conversation" ADD COLUMN "agentHistorySeededAt" TIMESTAMP(3);
ALTER TABLE "AgentTurn" ADD COLUMN "dedupeKey" TEXT;
ALTER TABLE "AgentTurn" ADD COLUMN "agentRunId" UUID;
ALTER TABLE "AgentTurn" ADD COLUMN "decision" JSONB;
ALTER TABLE "AgentTurn" ADD COLUMN "failureReason" TEXT;
ALTER TABLE "ConversationMessage" ADD COLUMN "agentTurnId" INTEGER;
CREATE UNIQUE INDEX "Conversation_agentThreadId_key" ON "Conversation"("agentThreadId");
CREATE UNIQUE INDEX "AgentTurn_dedupeKey_key" ON "AgentTurn"("dedupeKey");
CREATE UNIQUE INDEX "AgentTurn_agentRunId_key" ON "AgentTurn"("agentRunId");
CREATE UNIQUE INDEX "ConversationMessage_agentTurnId_key" ON "ConversationMessage"("agentTurnId");
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_agentTurnId_fkey"
  FOREIGN KEY ("agentTurnId") REFERENCES "AgentTurn"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
