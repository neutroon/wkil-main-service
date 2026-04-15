-- AlterTable
ALTER TABLE "public"."Conversation" ADD COLUMN     "postUrl" TEXT;

-- AlterTable
ALTER TABLE "public"."ConversationMessage" ADD COLUMN     "intent" TEXT;

-- AlterTable
ALTER TABLE "public"."FacebookPage" ADD COLUMN     "commentAutoDmEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "commentPublicGreeting" TEXT NOT NULL DEFAULT 'Thanks {{name}}! I''ve sent the details to your inbox.',
ADD COLUMN     "responseMode" TEXT NOT NULL DEFAULT 'AUTO';
