-- Track the one-time Coexistence app-data synchronization requests.
ALTER TABLE "WhatsAppAccount"
  ADD COLUMN "coexistenceContactsSyncRequestedAt" TIMESTAMP(3),
  ADD COLUMN "coexistenceHistorySyncRequestedAt" TIMESTAMP(3),
  ADD COLUMN "coexistenceSyncLastAttemptAt" TIMESTAMP(3),
  ADD COLUMN "coexistenceSyncLastError" TEXT;
