-- CreateTable
CREATE TABLE "public"."ProcessedWhatsAppMessage" (
    "id" SERIAL NOT NULL,
    "wamid" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedWhatsAppMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WhatsAppAccount" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "displayPhoneNumber" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "accessToken" TEXT NOT NULL,
    "businessProfileId" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedWhatsAppMessage_wamid_key" ON "public"."ProcessedWhatsAppMessage"("wamid");

-- CreateIndex
CREATE INDEX "WhatsAppAccount_userId_idx" ON "public"."WhatsAppAccount"("userId");

-- CreateIndex
CREATE INDEX "WhatsAppAccount_phoneNumberId_idx" ON "public"."WhatsAppAccount"("phoneNumberId");

-- CreateIndex
CREATE INDEX "WhatsAppAccount_businessProfileId_idx" ON "public"."WhatsAppAccount"("businessProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccount_userId_phoneNumberId_key" ON "public"."WhatsAppAccount"("userId", "phoneNumberId");

-- AddForeignKey
ALTER TABLE "public"."WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
