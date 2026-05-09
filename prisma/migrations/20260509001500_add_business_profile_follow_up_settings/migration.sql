ALTER TABLE "BusinessProfile"
ADD COLUMN "followUpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "followUpMode" TEXT NOT NULL DEFAULT 'AUTO',
ADD COLUMN "followUpDelays" JSONB,
ADD COLUMN "followUpInstructions" TEXT;
