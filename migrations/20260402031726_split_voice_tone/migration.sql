/*
  Warnings:

  - You are about to drop the column `voiceAndTone` on the `BusinessProfile` table. All the data in the column will be lost.
  - Added the required column `tone` to the `BusinessProfile` table without a default value. This is not possible if the table is not empty.
  - Added the required column `voice` to the `BusinessProfile` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "public"."BusinessProfile" DROP COLUMN "voiceAndTone",
ADD COLUMN     "tone" TEXT NOT NULL,
ADD COLUMN     "voice" TEXT NOT NULL;
