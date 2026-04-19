-- AlterTable
ALTER TABLE "public"."ConversationMessage" ADD COLUMN     "isPrivate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "origin" TEXT;
