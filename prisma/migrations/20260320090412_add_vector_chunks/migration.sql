CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "public"."BusinessProfile" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "identity" TEXT NOT NULL,
    "targetAudience" TEXT NOT NULL,
    "voiceAndTone" TEXT NOT NULL,
    "productsServices" TEXT[],
    "expectedUserIntents" TEXT[],
    "corePolicies" TEXT NOT NULL,
    "phoneNumbers" TEXT[],
    "workingHours" TEXT,
    "address" TEXT,
    "faqs" TEXT[],
    "scrapedWebsiteUrl" TEXT,
    "scrapedRawMarkdown" TEXT,
    "ragIgested" BOOLEAN NOT NULL DEFAULT false,
    "ragIngestedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BusinessProfileChunk" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "chunkType" TEXT NOT NULL,
    "embedding" vector(768) NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfileChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessProfileChunk_businessProfileId_idx" ON "public"."BusinessProfileChunk"("businessProfileId");

-- CreateIndex
CREATE INDEX "BusinessProfileChunk_businessProfileId_chunkType_idx" ON "public"."BusinessProfileChunk"("businessProfileId", "chunkType");

-- AddForeignKey
ALTER TABLE "public"."BusinessProfile" ADD CONSTRAINT "BusinessProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BusinessProfileChunk" ADD CONSTRAINT "BusinessProfileChunk_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

---- Add the ivfflat index for fast similarity search
CREATE INDEX ON "BusinessProfileChunk" 
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);