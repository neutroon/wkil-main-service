-- Signal-led content audit, brief, and strategic post metadata.

CREATE TABLE "ContentAudit" (
  "id" SERIAL NOT NULL,
  "businessProfileId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running',
  "signalWindowDays" INTEGER NOT NULL DEFAULT 90,
  "competitorDiscoveryScope" TEXT NOT NULL DEFAULT 'PROVIDED_ONLY',
  "competitorAnalysisModes" TEXT[] NOT NULL,
  "campaignGoal" TEXT,
  "startDate" TIMESTAMP(3),
  "endDate" TIMESTAMP(3),
  "findings" JSONB,
  "gapQuestions" JSONB,
  "draftBrief" JSONB,
  "evidenceRefs" JSONB,
  "confidenceScore" DOUBLE PRECISION,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContentAudit_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ContentBrief" (
  "id" SERIAL NOT NULL,
  "businessProfileId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "sourceAuditId" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'confirmed',
  "goal" TEXT,
  "audienceSegments" JSONB,
  "painPoints" JSONB,
  "objections" JSONB,
  "buyingTriggers" JSONB,
  "offers" JSONB,
  "proofPoints" JSONB,
  "cta" TEXT,
  "funnelFocus" TEXT,
  "tonePreferences" TEXT,
  "forbiddenTopics" JSONB,
  "competitorInsights" JSONB,
  "ownerAnswers" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ContentBrief_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompetitorSource" (
  "id" SERIAL NOT NULL,
  "businessProfileId" INTEGER NOT NULL,
  "contentAuditId" INTEGER,
  "name" TEXT,
  "url" TEXT,
  "sourceType" TEXT NOT NULL DEFAULT 'website',
  "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "summary" JSONB,
  "evidenceRefs" JSONB,
  "errorMessage" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "CompetitorSource_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ContentPlan"
ADD COLUMN "contentBriefId" INTEGER,
ADD COLUMN "briefSnapshot" JSONB;

ALTER TABLE "ContentPlanPost"
ADD COLUMN "funnelStage" TEXT,
ADD COLUMN "contentGoal" TEXT,
ADD COLUMN "targetPainPoint" TEXT,
ADD COLUMN "objectionHandled" TEXT,
ADD COLUMN "cta" TEXT,
ADD COLUMN "rationale" TEXT,
ADD COLUMN "evidenceRefs" JSONB;

CREATE INDEX "ContentAudit_businessProfileId_createdAt_idx" ON "ContentAudit"("businessProfileId", "createdAt");
CREATE INDEX "ContentAudit_userId_createdAt_idx" ON "ContentAudit"("userId", "createdAt");
CREATE INDEX "ContentAudit_status_idx" ON "ContentAudit"("status");

CREATE INDEX "ContentBrief_businessProfileId_createdAt_idx" ON "ContentBrief"("businessProfileId", "createdAt");
CREATE INDEX "ContentBrief_userId_createdAt_idx" ON "ContentBrief"("userId", "createdAt");
CREATE INDEX "ContentBrief_sourceAuditId_idx" ON "ContentBrief"("sourceAuditId");

CREATE INDEX "CompetitorSource_businessProfileId_createdAt_idx" ON "CompetitorSource"("businessProfileId", "createdAt");
CREATE INDEX "CompetitorSource_contentAuditId_idx" ON "CompetitorSource"("contentAuditId");
CREATE INDEX "CompetitorSource_status_idx" ON "CompetitorSource"("status");

ALTER TABLE "ContentAudit"
ADD CONSTRAINT "ContentAudit_businessProfileId_fkey"
FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentAudit"
ADD CONSTRAINT "ContentAudit_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentBrief"
ADD CONSTRAINT "ContentBrief_businessProfileId_fkey"
FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentBrief"
ADD CONSTRAINT "ContentBrief_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentBrief"
ADD CONSTRAINT "ContentBrief_sourceAuditId_fkey"
FOREIGN KEY ("sourceAuditId") REFERENCES "ContentAudit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CompetitorSource"
ADD CONSTRAINT "CompetitorSource_businessProfileId_fkey"
FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompetitorSource"
ADD CONSTRAINT "CompetitorSource_contentAuditId_fkey"
FOREIGN KEY ("contentAuditId") REFERENCES "ContentAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ContentPlan"
ADD CONSTRAINT "ContentPlan_contentBriefId_fkey"
FOREIGN KEY ("contentBriefId") REFERENCES "ContentBrief"("id") ON DELETE SET NULL ON UPDATE CASCADE;
