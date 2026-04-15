-- AlterTable
ALTER TABLE "public"."BusinessProfile" ALTER COLUMN "corePolicies" DROP NOT NULL;

-- CreateTable
CREATE TABLE "public"."BusinessProfileKnowledgeSection" (
    "id" SERIAL NOT NULL,
    "businessId" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfileKnowledgeSection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessProfileKnowledgeSection_businessId_idx" ON "public"."BusinessProfileKnowledgeSection"("businessId");

-- AddForeignKey
ALTER TABLE "public"."BusinessProfileKnowledgeSection" ADD CONSTRAINT "BusinessProfileKnowledgeSection_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
