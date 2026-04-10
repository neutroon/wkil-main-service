-- CreateTable
CREATE TABLE "public"."ContentPlan" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "goals" TEXT,
    "currentTrends" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ContentPlanPost" (
    "id" SERIAL NOT NULL,
    "contentPlanId" INTEGER NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "platform" TEXT NOT NULL,
    "pillar" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "caption" TEXT,
    "imagePrompt" TEXT,
    "imageUrl" TEXT,
    "reelScript" TEXT,
    "carouselSlides" JSONB,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "postedAt" TIMESTAMP(3),
    "facebookPostId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPlanPost_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "public"."ContentPlan" ADD CONSTRAINT "ContentPlan_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContentPlan" ADD CONSTRAINT "ContentPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContentPlanPost" ADD CONSTRAINT "ContentPlanPost_contentPlanId_fkey" FOREIGN KEY ("contentPlanId") REFERENCES "public"."ContentPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
