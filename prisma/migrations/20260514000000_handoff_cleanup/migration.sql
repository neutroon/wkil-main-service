-- Remove legacy manual-review drafts and correction records.
DELETE FROM "ConversationMessage" WHERE "status" = 'PENDING_REVIEW';
UPDATE "ConversationMessage" SET "status" = 'SENT' WHERE "status" = 'EDITED_AND_SENT';

ALTER TABLE "BusinessProfile" ADD COLUMN IF NOT EXISTS "handoffEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "BusinessProfile" DROP COLUMN IF EXISTS "responseMode";

ALTER TABLE "FacebookPage" DROP COLUMN IF EXISTS "responseMode";

DROP TABLE IF EXISTS "AiCorrection";
