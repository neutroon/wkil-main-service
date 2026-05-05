-- AlterTable
ALTER TABLE "public"."FacebookPage" ADD COLUMN     "webhookCheckedAt" TIMESTAMP(3),
ADD COLUMN     "webhookStatus" TEXT NOT NULL DEFAULT 'PENDING';
