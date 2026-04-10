-- AlterTable
ALTER TABLE "public"."ContentPlan" ADD COLUMN     "isGrounded" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "researchSummary" TEXT;
