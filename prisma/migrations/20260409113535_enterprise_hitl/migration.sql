-- AlterTable
ALTER TABLE "public"."BusinessProfile" ADD COLUMN     "responseMode" TEXT NOT NULL DEFAULT 'AUTO';

-- AlterTable
ALTER TABLE "public"."Conversation" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'OPEN';

-- AlterTable
ALTER TABLE "public"."ConversationMessage" ADD COLUMN     "aiReasoning" TEXT,
ADD COLUMN     "handoffCategory" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'SENT';

-- CreateTable
CREATE TABLE "public"."AiCorrection" (
    "id" SERIAL NOT NULL,
    "messageId" INTEGER NOT NULL,
    "originalAiText" TEXT NOT NULL,
    "humanEditedText" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiCorrection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiCorrection_messageId_key" ON "public"."AiCorrection"("messageId");

-- CreateIndex
CREATE INDEX "AiCorrection_messageId_idx" ON "public"."AiCorrection"("messageId");

-- AddForeignKey
ALTER TABLE "public"."AiCorrection" ADD CONSTRAINT "AiCorrection_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."ConversationMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
