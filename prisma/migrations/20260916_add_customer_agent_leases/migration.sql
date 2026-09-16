ALTER TABLE "Conversation" ADD COLUMN "agentSeedLeaseOwner" UUID;
ALTER TABLE "Conversation" ADD COLUMN "agentSeedLeaseExpiresAt" TIMESTAMP(3);
ALTER TABLE "AgentTurn" ADD COLUMN "runLeaseOwner" UUID;
ALTER TABLE "AgentTurn" ADD COLUMN "runLeaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "Conversation_agentSeedLeaseExpiresAt_idx"
  ON "Conversation"("agentSeedLeaseExpiresAt");
CREATE INDEX "AgentTurn_runLeaseExpiresAt_idx"
  ON "AgentTurn"("runLeaseExpiresAt");
