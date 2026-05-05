/*
  Warnings:

  - A unique constraint covering the columns `[previousRefreshTokenHash]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "previousRefreshTokenHash" TEXT,
ADD COLUMN     "rotatedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "User_previousRefreshTokenHash_key" ON "public"."User"("previousRefreshTokenHash");
