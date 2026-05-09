-- CreateTable
CREATE TABLE "public"."Customer" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "displayName" TEXT NOT NULL,
    "phone" TEXT,
    "normalizedPhone" TEXT,
    "email" TEXT,
    "normalizedEmail" TEXT,
    "avatarUrl" TEXT,
    "primaryChannel" TEXT,
    "externalIds" JSONB,
    "capturedFields" JSONB,
    "metadata" JSONB,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "lastInteractionAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CustomerExternalIdentity" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "customerId" INTEGER NOT NULL,
    "channel" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CustomerExternalIdentity_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "public"."Conversation" ADD COLUMN "customerId" INTEGER;

-- AlterTable
ALTER TABLE "public"."CrmDeliveryLog" ADD COLUMN "customerId" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "Customer_businessProfileId_normalizedPhone_key" ON "public"."Customer"("businessProfileId", "normalizedPhone");
CREATE UNIQUE INDEX "Customer_businessProfileId_normalizedEmail_key" ON "public"."Customer"("businessProfileId", "normalizedEmail");
CREATE INDEX "Customer_businessProfileId_lastInteractionAt_idx" ON "public"."Customer"("businessProfileId", "lastInteractionAt");
CREATE INDEX "Customer_businessProfileId_status_idx" ON "public"."Customer"("businessProfileId", "status");
CREATE UNIQUE INDEX "CustomerExternalIdentity_businessProfileId_channel_externalId_key" ON "public"."CustomerExternalIdentity"("businessProfileId", "channel", "externalId");
CREATE INDEX "CustomerExternalIdentity_customerId_idx" ON "public"."CustomerExternalIdentity"("customerId");
CREATE INDEX "Conversation_customerId_idx" ON "public"."Conversation"("customerId");
CREATE INDEX "CrmDeliveryLog_customerId_idx" ON "public"."CrmDeliveryLog"("customerId");

-- AddForeignKey
ALTER TABLE "public"."Customer" ADD CONSTRAINT "Customer_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "public"."BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."CustomerExternalIdentity" ADD CONSTRAINT "CustomerExternalIdentity_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "public"."Conversation" ADD CONSTRAINT "Conversation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "public"."CrmDeliveryLog" ADD CONSTRAINT "CrmDeliveryLog_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "public"."Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill phone-based customers. Multiple conversations with the same phone
-- become one customer.
WITH conversation_seed AS (
    SELECT
        c.*,
        COALESCE(c."channel", 'whatsapp') AS seed_channel,
        NULLIF(COALESCE(c."customerPhone", CASE WHEN c."channel" = 'whatsapp' OR c."channel" IS NULL THEN c."senderId" ELSE NULL END), '') AS seed_phone,
        NULLIF(regexp_replace(COALESCE(c."customerPhone", CASE WHEN c."channel" = 'whatsapp' OR c."channel" IS NULL THEN c."senderId" ELSE NULL END, ''), '[^0-9+]', '', 'g'), '') AS seed_normalized_phone
    FROM "public"."Conversation" c
),
phone_seed AS (
    SELECT DISTINCT ON ("businessProfileId", seed_normalized_phone)
        "businessProfileId",
        COALESCE(NULLIF("customerName", ''), seed_phone, "senderId", 'Customer') AS "displayName",
        seed_phone AS "phone",
        seed_normalized_phone AS "normalizedPhone",
        "customerAvatar" AS "avatarUrl",
        seed_channel AS "primaryChannel",
        jsonb_build_object(seed_channel, jsonb_build_array("senderId")) AS "externalIds",
        "updatedAt" AS "lastInteractionAt",
        "createdAt"
    FROM conversation_seed
    WHERE seed_normalized_phone IS NOT NULL
    ORDER BY "businessProfileId", seed_normalized_phone, "updatedAt" DESC
)
INSERT INTO "public"."Customer" (
    "businessProfileId",
    "displayName",
    "phone",
    "normalizedPhone",
    "avatarUrl",
    "primaryChannel",
    "externalIds",
    "lastInteractionAt",
    "createdAt",
    "updatedAt"
)
SELECT
    "businessProfileId",
    "displayName",
    "phone",
    "normalizedPhone",
    "avatarUrl",
    "primaryChannel",
    "externalIds",
    "lastInteractionAt",
    "createdAt",
    CURRENT_TIMESTAMP
FROM phone_seed
ON CONFLICT ("businessProfileId", "normalizedPhone") DO NOTHING;

-- Backfill sender-based customers where no phone exists.
WITH conversation_seed AS (
    SELECT
        c.*,
        COALESCE(c."channel", 'web') AS seed_channel,
        NULLIF(regexp_replace(COALESCE(c."customerPhone", CASE WHEN c."channel" = 'whatsapp' OR c."channel" IS NULL THEN c."senderId" ELSE NULL END, ''), '[^0-9+]', '', 'g'), '') AS seed_normalized_phone
    FROM "public"."Conversation" c
),
sender_seed AS (
    SELECT DISTINCT ON ("businessProfileId", seed_channel, "senderId")
        "businessProfileId",
        COALESCE(NULLIF("customerName", ''), "senderId", 'Customer') AS "displayName",
        "customerAvatar" AS "avatarUrl",
        seed_channel AS "primaryChannel",
        "senderId",
        jsonb_build_object(seed_channel, jsonb_build_array("senderId")) AS "externalIds",
        "updatedAt" AS "lastInteractionAt",
        "createdAt"
    FROM conversation_seed
    WHERE seed_normalized_phone IS NULL
    ORDER BY "businessProfileId", seed_channel, "senderId", "updatedAt" DESC
)
INSERT INTO "public"."Customer" (
    "businessProfileId",
    "displayName",
    "avatarUrl",
    "primaryChannel",
    "externalIds",
    "lastInteractionAt",
    "createdAt",
    "updatedAt"
)
SELECT
    "businessProfileId",
    "displayName",
    "avatarUrl",
    "primaryChannel",
    "externalIds",
    "lastInteractionAt",
    "createdAt",
    CURRENT_TIMESTAMP
FROM sender_seed;

-- Backfill customer identities for all conversations.
INSERT INTO "public"."CustomerExternalIdentity" (
    "businessProfileId",
    "customerId",
    "channel",
    "externalId",
    "createdAt",
    "updatedAt"
)
SELECT
    c."businessProfileId",
    cust."id",
    COALESCE(c."channel", CASE WHEN phone.seed_normalized_phone IS NOT NULL THEN 'whatsapp' ELSE 'web' END),
    c."senderId",
    MIN(c."createdAt"),
    CURRENT_TIMESTAMP
FROM "public"."Conversation" c
CROSS JOIN LATERAL (
    SELECT NULLIF(regexp_replace(COALESCE(c."customerPhone", CASE WHEN c."channel" = 'whatsapp' OR c."channel" IS NULL THEN c."senderId" ELSE NULL END, ''), '[^0-9+]', '', 'g'), '') AS seed_normalized_phone
) phone
JOIN "public"."Customer" cust
  ON cust."businessProfileId" = c."businessProfileId"
 AND (
    (phone.seed_normalized_phone IS NOT NULL AND cust."normalizedPhone" = phone.seed_normalized_phone)
    OR (
      phone.seed_normalized_phone IS NULL
      AND cust."primaryChannel" = COALESCE(c."channel", 'web')
      AND cust."externalIds" = jsonb_build_object(COALESCE(c."channel", 'web'), jsonb_build_array(c."senderId"))
    )
 )
GROUP BY c."businessProfileId", cust."id", COALESCE(c."channel", CASE WHEN phone.seed_normalized_phone IS NOT NULL THEN 'whatsapp' ELSE 'web' END), c."senderId"
ON CONFLICT ("businessProfileId", "channel", "externalId") DO NOTHING;

UPDATE "public"."Conversation" c
SET "customerId" = cei."customerId"
FROM "public"."CustomerExternalIdentity" cei
WHERE cei."businessProfileId" = c."businessProfileId"
  AND cei."channel" = COALESCE(c."channel", CASE WHEN NULLIF(regexp_replace(COALESCE(c."customerPhone", CASE WHEN c."channel" = 'whatsapp' OR c."channel" IS NULL THEN c."senderId" ELSE NULL END, ''), '[^0-9+]', '', 'g'), '') IS NOT NULL THEN 'whatsapp' ELSE 'web' END)
  AND cei."externalId" = c."senderId"
  AND c."customerId" IS NULL;
