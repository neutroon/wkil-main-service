CREATE TABLE "public"."IntegrationActionRun" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "sourceId" INTEGER NOT NULL,
    "conversationId" INTEGER,
    "customerId" INTEGER,
    "trigger" TEXT NOT NULL,
    "actionType" TEXT,
    "toolName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "jobId" TEXT,
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "verification" TEXT,
    "failureReason" TEXT,
    "resultMessageId" INTEGER,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationActionRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "IntegrationActionRun_businessProfileId_status_createdAt_idx" ON "public"."IntegrationActionRun"("businessProfileId", "status", "createdAt");
CREATE INDEX "IntegrationActionRun_conversationId_createdAt_idx" ON "public"."IntegrationActionRun"("conversationId", "createdAt");
CREATE INDEX "IntegrationActionRun_sourceId_createdAt_idx" ON "public"."IntegrationActionRun"("sourceId", "createdAt");
CREATE INDEX "IntegrationActionRun_jobId_idx" ON "public"."IntegrationActionRun"("jobId");

ALTER TABLE "public"."IntegrationActionRun" ADD CONSTRAINT "IntegrationActionRun_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."IntegrationActionRun" ADD CONSTRAINT "IntegrationActionRun_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "public"."ExternalDataSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."IntegrationActionRun" ADD CONSTRAINT "IntegrationActionRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "public"."Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
