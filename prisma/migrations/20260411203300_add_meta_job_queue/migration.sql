-- CreateTable
CREATE TABLE "public"."MetaJob" (
    "id" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MetaJob_status_nextAttemptAt_idx" ON "public"."MetaJob"("status", "nextAttemptAt");
