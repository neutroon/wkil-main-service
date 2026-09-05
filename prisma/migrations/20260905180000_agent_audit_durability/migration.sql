ALTER TABLE "AiCallLog" ADD COLUMN "eventId" TEXT;
CREATE UNIQUE INDEX "AiCallLog_eventId_key" ON "AiCallLog"("eventId");

CREATE TABLE "AgentOperation" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" INTEGER NOT NULL,
  "businessProfileId" INTEGER,
  "requestHash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "statusCode" INTEGER,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "AgentOperation_userId_createdAt_idx" ON "AgentOperation"("userId", "createdAt");

CREATE TABLE "AgentModelReservation" (
  "userId" INTEGER NOT NULL PRIMARY KEY,
  "eventId" TEXT NOT NULL UNIQUE,
  "reservedCredits" INTEGER NOT NULL,
  "businessProfileId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "RagIndexState" (
  "businessProfileId" INTEGER NOT NULL PRIMARY KEY,
  "requestedRevision" INTEGER NOT NULL DEFAULT 0,
  "activeRevision" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RagIndexState_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
