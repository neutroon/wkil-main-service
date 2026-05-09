ALTER TABLE "public"."ExternalDataSource"
  ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'CHAT_REQUESTED';

ALTER TABLE "public"."ExternalDataSource"
  ALTER COLUMN "executionMode" SET DEFAULT 'BACKGROUND';
