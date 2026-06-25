-- Allow nullable email on User (social users from providers that do not return an email)
-- Allow nullable email on SocialIdentity (mirrors User.email semantics)
ALTER TABLE "public"."User" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "public"."SocialIdentity" ALTER COLUMN "email" DROP NOT NULL;

-- Persisted avatar (seeded from first social identity, editable by user)
ALTER TABLE "public"."User" ADD COLUMN "avatar" TEXT;

-- Track accounts originally created via social login so the AuthGuard verification gate
-- does not redirect them to /auth/verification-pending (they have no email to verify)
ALTER TABLE "public"."User" ADD COLUMN "isSocialUser" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: any user that already has a linked SocialIdentity was effectively registered
-- via social login, even if the original flow required an email.
UPDATE "public"."User" u
SET "isSocialUser" = true
WHERE EXISTS (SELECT 1 FROM "public"."SocialIdentity" si WHERE si."userId" = u.id);

-- Backfill: seed User.avatar from the most recently-updated SocialIdentity.avatarUrl per user
UPDATE "public"."User" u
SET "avatar" = latest.avatar_url
FROM (
  SELECT DISTINCT ON (si."userId") si."userId" AS user_id, si."avatarUrl" AS avatar_url
  FROM "public"."SocialIdentity" si
  WHERE si."avatarUrl" IS NOT NULL
  ORDER BY si."userId", si."updatedAt" DESC
) latest
WHERE latest.user_id = u.id
  AND u."avatar" IS NULL;
