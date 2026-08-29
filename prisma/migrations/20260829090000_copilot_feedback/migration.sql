-- CopilotFeedback: per-message thumbs up/down from the wkil assistant.
-- One vote per user per message (latest wins via upsert).

-- CreateTable
CREATE TABLE "CopilotFeedback" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "threadId" TEXT,
    "messageId" TEXT NOT NULL,
    "rating" TEXT NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopilotFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CopilotFeedback_userId_messageId_key" ON "CopilotFeedback"("userId", "messageId");

-- CreateIndex
CREATE INDEX "CopilotFeedback_threadId_idx" ON "CopilotFeedback"("threadId");
