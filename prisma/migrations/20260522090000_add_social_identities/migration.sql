CREATE TABLE "public"."SocialIdentity" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SocialIdentity_provider_providerUserId_key" ON "public"."SocialIdentity"("provider", "providerUserId");
CREATE INDEX "SocialIdentity_userId_idx" ON "public"."SocialIdentity"("userId");
CREATE INDEX "SocialIdentity_email_idx" ON "public"."SocialIdentity"("email");

ALTER TABLE "public"."SocialIdentity" ADD CONSTRAINT "SocialIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
