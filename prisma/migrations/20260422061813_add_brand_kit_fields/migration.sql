-- CreateEnum
CREATE TYPE "public"."WatermarkPosition" AS ENUM ('TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_RIGHT', 'CENTER');

-- AlterTable
ALTER TABLE "public"."BusinessProfile" ADD COLUMN     "artStyle" TEXT,
ADD COLUMN     "brandAccentColor" TEXT,
ADD COLUMN     "brandKitCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "brandKitUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "brandLogoUrl" TEXT,
ADD COLUMN     "brandPrimaryColor" TEXT,
ADD COLUMN     "brandSecondaryColor" TEXT,
ADD COLUMN     "brandWatermarkEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "visualAesthetic" TEXT,
ADD COLUMN     "watermarkPosition" "public"."WatermarkPosition" NOT NULL DEFAULT 'BOTTOM_RIGHT';
