-- AlterTable
ALTER TABLE "public"."FacebookPage" ADD COLUMN     "followersCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pictureUrl" TEXT;
