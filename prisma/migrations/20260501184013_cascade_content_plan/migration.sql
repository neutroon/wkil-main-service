-- DropForeignKey
ALTER TABLE "public"."ContentPlan" DROP CONSTRAINT "ContentPlan_businessProfileId_fkey";

-- DropForeignKey
ALTER TABLE "public"."ContentPlan" DROP CONSTRAINT "ContentPlan_userId_fkey";

-- AddForeignKey
ALTER TABLE "public"."ContentPlan" ADD CONSTRAINT "ContentPlan_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContentPlan" ADD CONSTRAINT "ContentPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
