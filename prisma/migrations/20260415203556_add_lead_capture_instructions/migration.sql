-- AlterTable
ALTER TABLE "public"."BusinessProfile" ADD COLUMN     "leadCaptureInstructions" TEXT DEFAULT 'Captures a prospective lead''s information. Trigger this ONLY when the user explicitly expresses strong buying intent, asks for a callback, tells you their contact details, or wants to proceed with an action.';
