-- AlterTable
ALTER TABLE "public"."ContentPlanPost" ADD COLUMN     "mediaAssetId" INTEGER;

-- AddForeignKey
ALTER TABLE "public"."ContentPlanPost" ADD CONSTRAINT "ContentPlanPost_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "public"."BusinessProfileMedia"("id") ON DELETE SET NULL ON UPDATE CASCADE;
