-- AlterTable
ALTER TABLE "public"."FacebookPage" ADD COLUMN     "businessProfileId" INTEGER;

-- CreateIndex
CREATE INDEX "FacebookPage_businessProfileId_idx" ON "public"."FacebookPage"("businessProfileId");

-- AddForeignKey
ALTER TABLE "public"."FacebookPage" ADD CONSTRAINT "FacebookPage_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
