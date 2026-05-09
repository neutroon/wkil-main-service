ALTER TABLE "public"."BusinessProfile"
  RENAME COLUMN "leadCaptureInstructions" TO "customerDetailsInstructions";

ALTER TABLE "public"."BusinessProfile"
  ALTER COLUMN "customerDetailsInstructions"
  SET DEFAULT 'Saves useful customer details. Trigger this ONLY when the customer provides contact details, asks for follow-up, wants to proceed, gives preferences, or corrects saved information.';
