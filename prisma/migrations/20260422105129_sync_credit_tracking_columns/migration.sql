-- AlterTable
ALTER TABLE "public"."BusinessProfile" ADD COLUMN     "monthlyCreditQuota" INTEGER,
ADD COLUMN     "monthlyCreditsUsed" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "monthlyCreditQuota" INTEGER,
ADD COLUMN     "monthlyCreditsUsed" INTEGER NOT NULL DEFAULT 0;
