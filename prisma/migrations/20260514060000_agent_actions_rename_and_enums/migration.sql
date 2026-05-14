-- Agent Actions V2 cleanup:
-- - Preserve chat-requested action sources while renaming the table/model.
-- - Remove obsolete non-chat action sources from the old V1 surface.
-- - Convert high-risk string statuses into constrained enums.

DELETE FROM "ExternalDataSource"
WHERE "trigger" IS DISTINCT FROM 'CHAT_REQUESTED';

UPDATE "ExternalDataSource"
SET "actionType" = 'LOOKUP'
WHERE "actionType" IS NULL OR "actionType" NOT IN ('LOOKUP', 'MUTATION');

UPDATE "ConversationMessage"
SET "status" = 'SENT'
WHERE "status" NOT IN ('SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

UPDATE "AgentTurn"
SET "mode" = 'CUSTOMER_MESSAGE'
WHERE "mode" NOT IN ('CUSTOMER_MESSAGE', 'ACTION_RESULT');

UPDATE "AgentTurn"
SET "status" = 'FAILED'
WHERE "status" NOT IN ('RUNNING', 'WAITING_ACTION', 'COMPLETED', 'FAILED');

UPDATE "IntegrationActionRun"
SET "trigger" = 'CHAT_REQUESTED'
WHERE "trigger" IS DISTINCT FROM 'CHAT_REQUESTED';

UPDATE "IntegrationActionRun"
SET "actionType" = NULL
WHERE "actionType" IS NOT NULL AND "actionType" NOT IN ('LOOKUP', 'MUTATION');

UPDATE "IntegrationActionRun"
SET "status" = 'FAILED'
WHERE "status" NOT IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');

DO $$ BEGIN
  CREATE TYPE "ConversationMessageStatus" AS ENUM ('SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AgentTurnMode" AS ENUM ('CUSTOMER_MESSAGE', 'ACTION_RESULT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AgentTurnStatus" AS ENUM ('RUNNING', 'WAITING_ACTION', 'COMPLETED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "IntegrationActionRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AgentActionTrigger" AS ENUM ('CHAT_REQUESTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "AgentActionType" AS ENUM ('LOOKUP', 'MUTATION');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "ConversationMessage" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ConversationMessage"
  ALTER COLUMN "status" TYPE "ConversationMessageStatus"
  USING "status"::text::"ConversationMessageStatus";
ALTER TABLE "ConversationMessage" ALTER COLUMN "status" SET DEFAULT 'SENT';

ALTER TABLE "AgentTurn" ALTER COLUMN "mode" TYPE "AgentTurnMode" USING "mode"::text::"AgentTurnMode";
ALTER TABLE "AgentTurn" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "AgentTurn"
  ALTER COLUMN "status" TYPE "AgentTurnStatus"
  USING "status"::text::"AgentTurnStatus";
ALTER TABLE "AgentTurn" ALTER COLUMN "status" SET DEFAULT 'RUNNING';

ALTER TABLE "IntegrationActionRun" ALTER COLUMN "trigger" TYPE "AgentActionTrigger" USING "trigger"::text::"AgentActionTrigger";
ALTER TABLE "IntegrationActionRun" ALTER COLUMN "actionType" TYPE "AgentActionType" USING "actionType"::text::"AgentActionType";
ALTER TABLE "IntegrationActionRun" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "IntegrationActionRun"
  ALTER COLUMN "status" TYPE "IntegrationActionRunStatus"
  USING "status"::text::"IntegrationActionRunStatus";
ALTER TABLE "IntegrationActionRun" ALTER COLUMN "status" SET DEFAULT 'QUEUED';

ALTER TABLE "ExternalDataSource" ALTER COLUMN "trigger" DROP DEFAULT;
ALTER TABLE "ExternalDataSource" ALTER COLUMN "trigger" TYPE "AgentActionTrigger" USING "trigger"::text::"AgentActionTrigger";
ALTER TABLE "ExternalDataSource" ALTER COLUMN "trigger" SET DEFAULT 'CHAT_REQUESTED';
ALTER TABLE "ExternalDataSource" ALTER COLUMN "actionType" DROP DEFAULT;
ALTER TABLE "ExternalDataSource" ALTER COLUMN "actionType" TYPE "AgentActionType" USING "actionType"::text::"AgentActionType";
ALTER TABLE "ExternalDataSource" ALTER COLUMN "actionType" SET DEFAULT 'LOOKUP';

ALTER TABLE "ExternalDataSource" RENAME TO "AgentActionSource";
ALTER INDEX IF EXISTS "ExternalDataSource_pkey" RENAME TO "AgentActionSource_pkey";
ALTER INDEX IF EXISTS "ExternalDataSource_businessProfileId_idx" RENAME TO "AgentActionSource_businessProfileId_idx";
ALTER INDEX IF EXISTS "ExternalDataSource_businessProfileId_trigger_isActive_idx" RENAME TO "AgentActionSource_businessProfileId_trigger_isActive_idx";
ALTER INDEX IF EXISTS "ExternalDataSource_routingTextHash_idx" RENAME TO "AgentActionSource_routingTextHash_idx";
ALTER SEQUENCE IF EXISTS "ExternalDataSource_id_seq" RENAME TO "AgentActionSource_id_seq";
ALTER TABLE "AgentActionSource"
  RENAME CONSTRAINT "ExternalDataSource_businessProfileId_fkey" TO "AgentActionSource_businessProfileId_fkey";
