/*
  Warnings:

  - A unique constraint covering the columns `[facebookUserId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "facebookAccessToken" TEXT,
ADD COLUMN     "facebookUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_facebookUserId_key" ON "public"."User"("facebookUserId");
