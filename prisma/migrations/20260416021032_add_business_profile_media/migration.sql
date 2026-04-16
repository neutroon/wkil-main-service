-- CreateTable
CREATE TABLE "public"."BusinessProfileMedia" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "instructions" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "r2Key" TEXT NOT NULL,
    "publicUrl" TEXT NOT NULL,
    "whatsappMediaId" TEXT,
    "whatsappMediaExpiresAt" TIMESTAMP(3),
    "messengerAttachmentId" TEXT,
    "whatsappSyncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "messengerSyncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfileMedia_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessProfileMedia_businessProfileId_idx" ON "public"."BusinessProfileMedia"("businessProfileId");

-- CreateIndex
CREATE INDEX "BusinessProfileMedia_userId_idx" ON "public"."BusinessProfileMedia"("userId");

-- CreateIndex
CREATE INDEX "BusinessProfileMedia_isActive_businessProfileId_idx" ON "public"."BusinessProfileMedia"("isActive", "businessProfileId");

-- CreateIndex
CREATE INDEX "BusinessProfileMedia_whatsappMediaExpiresAt_idx" ON "public"."BusinessProfileMedia"("whatsappMediaExpiresAt");

-- AddForeignKey
ALTER TABLE "public"."BusinessProfileMedia" ADD CONSTRAINT "BusinessProfileMedia_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BusinessProfileMedia" ADD CONSTRAINT "BusinessProfileMedia_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
