-- Agent V2 durable turns, explicit two-step action workflows, and action-run correlation.

CREATE TABLE "AgentActionWorkflow" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "lookupSourceId" INTEGER,
    "mutationSourceId" INTEGER,
    "inputBindings" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentActionWorkflow_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentTurn" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "conversationId" INTEGER NOT NULL,
    "inputMessageId" INTEGER,
    "channel" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "customerText" TEXT NOT NULL,
    "parentActionRunId" INTEGER,
    "activeWorkflowId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTurn_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "IntegrationActionRun"
  ADD COLUMN "agentTurnId" INTEGER,
  ADD COLUMN "parentRunId" INTEGER,
  ADD COLUMN "workflowId" INTEGER,
  ADD COLUMN "stepKey" TEXT;

CREATE INDEX "AgentActionWorkflow_businessProfileId_isActive_idx" ON "AgentActionWorkflow"("businessProfileId", "isActive");
CREATE INDEX "AgentActionWorkflow_lookupSourceId_idx" ON "AgentActionWorkflow"("lookupSourceId");
CREATE INDEX "AgentActionWorkflow_mutationSourceId_idx" ON "AgentActionWorkflow"("mutationSourceId");

CREATE INDEX "AgentTurn_businessProfileId_status_createdAt_idx" ON "AgentTurn"("businessProfileId", "status", "createdAt");
CREATE INDEX "AgentTurn_conversationId_createdAt_idx" ON "AgentTurn"("conversationId", "createdAt");
CREATE INDEX "AgentTurn_parentActionRunId_idx" ON "AgentTurn"("parentActionRunId");
CREATE INDEX "AgentTurn_activeWorkflowId_idx" ON "AgentTurn"("activeWorkflowId");

CREATE INDEX "IntegrationActionRun_agentTurnId_idx" ON "IntegrationActionRun"("agentTurnId");
CREATE INDEX "IntegrationActionRun_parentRunId_idx" ON "IntegrationActionRun"("parentRunId");
CREATE INDEX "IntegrationActionRun_workflowId_idx" ON "IntegrationActionRun"("workflowId");
CREATE INDEX "IntegrationActionRun_stepKey_idx" ON "IntegrationActionRun"("stepKey");

ALTER TABLE "AgentActionWorkflow"
  ADD CONSTRAINT "AgentActionWorkflow_businessProfileId_fkey"
  FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentActionWorkflow"
  ADD CONSTRAINT "AgentActionWorkflow_lookupSourceId_fkey"
  FOREIGN KEY ("lookupSourceId") REFERENCES "ExternalDataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentActionWorkflow"
  ADD CONSTRAINT "AgentActionWorkflow_mutationSourceId_fkey"
  FOREIGN KEY ("mutationSourceId") REFERENCES "ExternalDataSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentTurn"
  ADD CONSTRAINT "AgentTurn_businessProfileId_fkey"
  FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentTurn"
  ADD CONSTRAINT "AgentTurn_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentTurn"
  ADD CONSTRAINT "AgentTurn_parentActionRunId_fkey"
  FOREIGN KEY ("parentActionRunId") REFERENCES "IntegrationActionRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "AgentTurn"
  ADD CONSTRAINT "AgentTurn_activeWorkflowId_fkey"
  FOREIGN KEY ("activeWorkflowId") REFERENCES "AgentActionWorkflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IntegrationActionRun"
  ADD CONSTRAINT "IntegrationActionRun_agentTurnId_fkey"
  FOREIGN KEY ("agentTurnId") REFERENCES "AgentTurn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IntegrationActionRun"
  ADD CONSTRAINT "IntegrationActionRun_parentRunId_fkey"
  FOREIGN KEY ("parentRunId") REFERENCES "IntegrationActionRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "IntegrationActionRun"
  ADD CONSTRAINT "IntegrationActionRun_workflowId_fkey"
  FOREIGN KEY ("workflowId") REFERENCES "AgentActionWorkflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;
