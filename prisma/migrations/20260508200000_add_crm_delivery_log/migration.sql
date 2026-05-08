-- CreateTable
CREATE TABLE "CrmDeliveryLog" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "integrationId" INTEGER NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "leadKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmDeliveryLog_businessProfileId_integrationId_idempotencyKey_key" ON "CrmDeliveryLog"("businessProfileId", "integrationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "CrmDeliveryLog_businessProfileId_integrationId_leadKey_status_idx" ON "CrmDeliveryLog"("businessProfileId", "integrationId", "leadKey", "status");

-- CreateIndex
CREATE INDEX "CrmDeliveryLog_businessProfileId_integrationId_payloadHash_status_idx" ON "CrmDeliveryLog"("businessProfileId", "integrationId", "payloadHash", "status");
