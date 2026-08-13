-- CreateEnum
CREATE TYPE "OrderEventProcessingStatus" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('AWAITING_CONFIRMATION', 'CONFIRMED', 'CANCELED');

-- CreateEnum
CREATE TYPE "OrderNotificationKind" AS ENUM ('CONFIRMATION_REQUEST', 'ACKNOWLEDGEMENT');

-- CreateEnum
CREATE TYPE "OrderNotificationStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderStoreSyncStatus" AS ENUM ('DISABLED', 'PENDING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "OrderAction" AS ENUM ('CONFIRM', 'CANCEL');

-- CreateTable
CREATE TABLE "OrderIntegration" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "whatsappAccountId" INTEGER,
    "kind" TEXT NOT NULL DEFAULT 'GENERIC',
    "integrationKey" TEXT NOT NULL,
    "signingSecret" TEXT NOT NULL,
    "previousSigningSecret" TEXT,
    "statusCallbackUrl" TEXT,
    "statusCallbackSecret" TEXT,
    "previousStatusCallbackSecret" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "storeSyncEnabled" BOOLEAN NOT NULL DEFAULT false,
    "defaultLocale" TEXT NOT NULL DEFAULT 'en',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderEvent" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "integrationId" INTEGER NOT NULL,
    "orderId" INTEGER,
    "externalEventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "rawPayload" JSONB,
    "rawPayloadRetentionUntil" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP + INTERVAL '30 days',
    "status" "OrderEventProcessingStatus" NOT NULL DEFAULT 'RECEIVED',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "integrationId" INTEGER NOT NULL,
    "externalOrderId" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'AWAITING_CONFIRMATION',
    "customerPhone" TEXT NOT NULL,
    "customerName" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "total" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL,
    "lineItems" JSONB,
    "shippingAddress" JSONB,
    "metadata" JSONB,
    "sourceStatus" TEXT,
    "paymentMethod" TEXT,
    "sourceCreatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderNotification" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "kind" "OrderNotificationKind" NOT NULL,
    "locale" TEXT NOT NULL,
    "templateConfigId" INTEGER,
    "renderedVariables" JSONB,
    "status" "OrderNotificationStatus" NOT NULL DEFAULT 'QUEUED',
    "providerMessageId" TEXT,
    "conversationMessageId" INTEGER,
    "idempotencyKey" TEXT NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderActionToken" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "notificationId" INTEGER NOT NULL,
    "action" "OrderAction" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderActionToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderStoreSync" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "orderId" INTEGER NOT NULL,
    "requestedStatus" "OrderStatus" NOT NULL,
    "status" "OrderStoreSyncStatus" NOT NULL DEFAULT 'PENDING',
    "providerIdempotencyKey" TEXT NOT NULL,
    "providerStatus" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderStoreSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderTemplateConfig" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "whatsappAccountId" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "languageCode" TEXT NOT NULL,
    "templateVersion" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "variableMapping" JSONB NOT NULL,
    "approvalStatus" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderTemplateConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsAppSuppression" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "normalizedPhone" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),

    CONSTRAINT "WhatsAppSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderIntegration_integrationKey_key" ON "OrderIntegration"("integrationKey");
CREATE INDEX "OrderIntegration_businessProfileId_isActive_idx" ON "OrderIntegration"("businessProfileId", "isActive");
CREATE INDEX "OrderIntegration_whatsappAccountId_idx" ON "OrderIntegration"("whatsappAccountId");

CREATE UNIQUE INDEX "OrderEvent_integrationId_externalEventId_key" ON "OrderEvent"("integrationId", "externalEventId");
CREATE INDEX "OrderEvent_businessProfileId_status_updatedAt_idx" ON "OrderEvent"("businessProfileId", "status", "updatedAt");
CREATE INDEX "OrderEvent_integrationId_status_receivedAt_idx" ON "OrderEvent"("integrationId", "status", "receivedAt");
CREATE INDEX "OrderEvent_orderId_idx" ON "OrderEvent"("orderId");

CREATE UNIQUE INDEX "Order_integrationId_externalOrderId_key" ON "Order"("integrationId", "externalOrderId");
CREATE INDEX "Order_businessProfileId_status_updatedAt_idx" ON "Order"("businessProfileId", "status", "updatedAt");
CREATE INDEX "Order_businessProfileId_customerPhone_idx" ON "Order"("businessProfileId", "customerPhone");

CREATE UNIQUE INDEX "OrderNotification_idempotencyKey_key" ON "OrderNotification"("idempotencyKey");
CREATE UNIQUE INDEX "OrderNotification_orderId_kind_key" ON "OrderNotification"("orderId", "kind");
CREATE INDEX "OrderNotification_businessProfileId_status_idx" ON "OrderNotification"("businessProfileId", "status");
CREATE INDEX "OrderNotification_orderId_status_idx" ON "OrderNotification"("orderId", "status");
CREATE INDEX "OrderNotification_conversationMessageId_idx" ON "OrderNotification"("conversationMessageId");

CREATE UNIQUE INDEX "OrderActionToken_tokenHash_key" ON "OrderActionToken"("tokenHash");
CREATE UNIQUE INDEX "OrderActionToken_orderId_action_key" ON "OrderActionToken"("orderId", "action");
CREATE INDEX "OrderActionToken_businessProfileId_idx" ON "OrderActionToken"("businessProfileId");
CREATE INDEX "OrderActionToken_orderId_idx" ON "OrderActionToken"("orderId");
CREATE INDEX "OrderActionToken_notificationId_idx" ON "OrderActionToken"("notificationId");

CREATE UNIQUE INDEX "OrderStoreSync_providerIdempotencyKey_key" ON "OrderStoreSync"("providerIdempotencyKey");
CREATE UNIQUE INDEX "OrderStoreSync_orderId_requestedStatus_key" ON "OrderStoreSync"("orderId", "requestedStatus");
CREATE INDEX "OrderStoreSync_businessProfileId_status_idx" ON "OrderStoreSync"("businessProfileId", "status");
CREATE INDEX "OrderStoreSync_orderId_status_idx" ON "OrderStoreSync"("orderId", "status");

CREATE INDEX "OrderTemplateConfig_businessProfileId_idx" ON "OrderTemplateConfig"("businessProfileId");
CREATE INDEX "OrderTemplateConfig_whatsappAccountId_eventType_locale_isAc_idx" ON "OrderTemplateConfig"("whatsappAccountId", "eventType", "locale", "isActive");

CREATE UNIQUE INDEX "WhatsAppSuppression_businessProfileId_normalizedPhone_key" ON "WhatsAppSuppression"("businessProfileId", "normalizedPhone");
CREATE INDEX "WhatsAppSuppression_businessProfileId_clearedAt_idx" ON "WhatsAppSuppression"("businessProfileId", "clearedAt");

-- AddForeignKey
ALTER TABLE "OrderIntegration" ADD CONSTRAINT "OrderIntegration_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderIntegration" ADD CONSTRAINT "OrderIntegration_whatsappAccountId_fkey" FOREIGN KEY ("whatsappAccountId") REFERENCES "WhatsAppAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "OrderIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Order" ADD CONSTRAINT "Order_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "OrderIntegration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_templateConfigId_fkey" FOREIGN KEY ("templateConfigId") REFERENCES "OrderTemplateConfig"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderNotification" ADD CONSTRAINT "OrderNotification_conversationMessageId_fkey" FOREIGN KEY ("conversationMessageId") REFERENCES "ConversationMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OrderActionToken" ADD CONSTRAINT "OrderActionToken_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderActionToken" ADD CONSTRAINT "OrderActionToken_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderActionToken" ADD CONSTRAINT "OrderActionToken_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "OrderNotification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderStoreSync" ADD CONSTRAINT "OrderStoreSync_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderStoreSync" ADD CONSTRAINT "OrderStoreSync_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderTemplateConfig" ADD CONSTRAINT "OrderTemplateConfig_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderTemplateConfig" ADD CONSTRAINT "OrderTemplateConfig_whatsappAccountId_fkey" FOREIGN KEY ("whatsappAccountId") REFERENCES "WhatsAppAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WhatsAppSuppression" ADD CONSTRAINT "WhatsAppSuppression_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
