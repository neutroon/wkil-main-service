-- AlterTable
ALTER TABLE "public"."ConversationMessage" ADD COLUMN     "mediaId" TEXT,
ADD COLUMN     "mediaMetadata" JSONB,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'text';
