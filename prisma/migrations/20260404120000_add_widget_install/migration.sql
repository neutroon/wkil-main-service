-- CreateTable
CREATE TABLE "public"."WidgetInstall" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "publicSiteKey" TEXT NOT NULL,
    "allowedOrigins" JSONB NOT NULL,
    "label" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WidgetInstall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WidgetInstall_publicSiteKey_key" ON "public"."WidgetInstall"("publicSiteKey");

-- CreateIndex
CREATE INDEX "WidgetInstall_userId_idx" ON "public"."WidgetInstall"("userId");

-- CreateIndex
CREATE INDEX "WidgetInstall_businessProfileId_idx" ON "public"."WidgetInstall"("businessProfileId");

-- AddForeignKey
ALTER TABLE "public"."WidgetInstall" ADD CONSTRAINT "WidgetInstall_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WidgetInstall" ADD CONSTRAINT "WidgetInstall_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
