ALTER TABLE "public"."BusinessProfileMedia"
ADD COLUMN IF NOT EXISTS "usageScope" TEXT NOT NULL DEFAULT 'CHAT_ATTACHMENT';

UPDATE "public"."BusinessProfileMedia"
SET "usageScope" = 'CONTENT_ASSET'
WHERE "name" LIKE 'AI_Branded_%'
   OR "name" LIKE '%_Refined_%'
   OR "instructions" LIKE 'Branded AI Image:%'
   OR "instructions" LIKE 'AI Refinement:%';

CREATE INDEX IF NOT EXISTS "BusinessProfileMedia_businessProfileId_usageScope_isActive_idx"
ON "public"."BusinessProfileMedia"("businessProfileId", "usageScope", "isActive");
