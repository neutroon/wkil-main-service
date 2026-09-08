ALTER TABLE "Customer"
  ALTER COLUMN "lastInteractionAt" DROP DEFAULT,
  ALTER COLUMN "lastInteractionAt" DROP NOT NULL;

CREATE TABLE "WhatsAppCoexistenceContactEvent" (
  "id" SERIAL NOT NULL,
  "businessProfileId" INTEGER NOT NULL,
  "phoneNumberId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "WhatsAppCoexistenceContactEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WhatsAppCoexistenceContactEvent_businessProfileId_phoneNumberId_eventKey_key"
  ON "WhatsAppCoexistenceContactEvent"("businessProfileId", "phoneNumberId", "eventKey");

CREATE INDEX "WhatsAppCoexistenceContactEvent_createdAt_idx"
  ON "WhatsAppCoexistenceContactEvent"("createdAt");

ALTER TABLE "WhatsAppCoexistenceContactEvent"
  ADD CONSTRAINT "WhatsAppCoexistenceContactEvent_businessProfileId_fkey"
  FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
