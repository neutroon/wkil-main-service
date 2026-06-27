-- Add RESOLVED status audit fields to Customer.
-- `status` keeps its free String shape but the column comment in
-- schema.prisma now documents the four supported values:
-- ACTIVE | NEEDS_FOLLOW_UP | RESOLVED | ARCHIVED.
ALTER TABLE "Customer"
  ADD COLUMN "resolvedAt" TIMESTAMP NULL,
  ADD COLUMN "resolvedByUserId" INTEGER NULL;

CREATE INDEX "Customer_businessProfileId_resolvedAt_idx"
  ON "Customer"("businessProfileId", "resolvedAt");
