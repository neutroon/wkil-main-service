-- CreateTable
CREATE TABLE "public"."BusinessProfileMediaSync" (
    "id" SERIAL NOT NULL,
    "mediaId" INTEGER NOT NULL,
    "platform" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "externalMediaId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'SYNCED',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfileMediaSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessProfileMediaSync_mediaId_idx" ON "public"."BusinessProfileMediaSync"("mediaId");

-- CreateIndex
CREATE INDEX "BusinessProfileMediaSync_platform_identifier_idx" ON "public"."BusinessProfileMediaSync"("platform", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfileMediaSync_mediaId_platform_identifier_key" ON "public"."BusinessProfileMediaSync"("mediaId", "platform", "identifier");

-- AddForeignKey
ALTER TABLE "public"."BusinessProfileMediaSync" ADD CONSTRAINT "BusinessProfileMediaSync_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "public"."BusinessProfileMedia"("id") ON DELETE CASCADE ON UPDATE CASCADE;
