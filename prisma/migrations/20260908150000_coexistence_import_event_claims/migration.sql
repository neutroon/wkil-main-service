CREATE TABLE "WhatsAppCoexistenceImportEvent" (
  "id" SERIAL NOT NULL,
  "businessProfileId" INTEGER NOT NULL,
  "phoneNumberId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WhatsAppCoexistenceImportEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppCoexistenceImportEvent_businessProfileId_phoneNumberId_eventKey_key"
  ON "WhatsAppCoexistenceImportEvent"("businessProfileId", "phoneNumberId", "eventKey");

CREATE INDEX "WhatsAppCoexistenceImportEvent_deliveredAt_idx"
  ON "WhatsAppCoexistenceImportEvent"("deliveredAt");

CREATE INDEX "WhatsAppCoexistenceImportEvent_createdAt_idx"
  ON "WhatsAppCoexistenceImportEvent"("createdAt");

ALTER TABLE "WhatsAppCoexistenceImportEvent"
  ADD CONSTRAINT "WhatsAppCoexistenceImportEvent_businessProfileId_fkey"
  FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
