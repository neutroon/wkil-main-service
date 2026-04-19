-- CreateTable
CREATE TABLE "public"."ProcessedFacebookComment" (
    "id" SERIAL NOT NULL,
    "commentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedFacebookComment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedFacebookComment_commentId_key" ON "public"."ProcessedFacebookComment"("commentId");
