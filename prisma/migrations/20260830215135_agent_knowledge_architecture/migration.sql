-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" SERIAL NOT NULL,
    "businessProfileId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "KnowledgeDocument_businessProfileId_kind_idx" ON "KnowledgeDocument"("businessProfileId", "kind");

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_businessProfileId_fkey" FOREIGN KEY ("businessProfileId") REFERENCES "BusinessProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed knowledge documents from legacy profile fields BEFORE dropping them
INSERT INTO "KnowledgeDocument" ("businessProfileId", "kind", "title", "content", "updatedAt")
SELECT id, 'identity', NULL, identity, NOW() FROM "BusinessProfile"
WHERE identity IS NOT NULL AND identity <> '';

INSERT INTO "KnowledgeDocument" ("businessProfileId", "kind", "title", "content", "updatedAt")
SELECT id, 'audience', NULL, "targetAudience", NOW() FROM "BusinessProfile"
WHERE "targetAudience" IS NOT NULL AND "targetAudience" <> '';

INSERT INTO "KnowledgeDocument" ("businessProfileId", "kind", "title", "content", "updatedAt")
SELECT id, 'products', 'Products & Services',
       (SELECT string_agg(p, E'\n') FROM unnest("productsServices") AS p), NOW()
FROM "BusinessProfile" WHERE array_length("productsServices", 1) > 0;

INSERT INTO "KnowledgeDocument" ("businessProfileId", "kind", "title", "content", "updatedAt")
SELECT id, 'contact', 'Contact & Hours',
       concat_ws(E'\n',
         CASE WHEN array_length("phoneNumbers", 1) > 0 THEN 'Phones: ' || array_to_string("phoneNumbers", ', ') END,
         CASE WHEN "workingHours" IS NOT NULL AND "workingHours" <> '' THEN 'Hours: ' || "workingHours" END,
         CASE WHEN "address" IS NOT NULL AND "address" <> '' THEN 'Address: ' || "address" END), NOW()
FROM "BusinessProfile"
WHERE array_length("phoneNumbers", 1) > 0
   OR ("workingHours" IS NOT NULL AND "workingHours" <> '')
   OR ("address" IS NOT NULL AND "address" <> '');

INSERT INTO "KnowledgeDocument" ("businessProfileId", "kind", "title", "content", "updatedAt")
SELECT id, 'website', 'Website', "scrapedWebsiteUrl", NOW() FROM "BusinessProfile"
WHERE "scrapedWebsiteUrl" IS NOT NULL AND "scrapedWebsiteUrl" <> '';

INSERT INTO "KnowledgeDocument" ("businessProfileId", "kind", "title", "content", "updatedAt")
SELECT "businessId", 'faq', question, 'Q: ' || question || E'\nA: ' || answer, NOW()
FROM "BusinessProfileFaq";

INSERT INTO "KnowledgeDocument" ("businessProfileId", "kind", "title", "content", "updatedAt")
SELECT "businessId", 'note', title, content, NOW()
FROM "BusinessProfileKnowledgeSection";

-- DropForeignKey
ALTER TABLE "BusinessProfileFaq" DROP CONSTRAINT "BusinessProfileFaq_businessId_fkey";

-- DropForeignKey
ALTER TABLE "BusinessProfileKnowledgeSection" DROP CONSTRAINT "BusinessProfileKnowledgeSection_businessId_fkey";

-- AlterTable
ALTER TABLE "BusinessProfile" DROP COLUMN "address",
DROP COLUMN "autoResetEnabled",
DROP COLUMN "brandKitUpdatedAt",
DROP COLUMN "brandWatermarkEnabled",
DROP COLUMN "facebookGreetingMode",
DROP COLUMN "facebookGreetingTemplate",
DROP COLUMN "identity",
DROP COLUMN "monthlyCreditQuota",
DROP COLUMN "phoneNumbers",
DROP COLUMN "plan",
DROP COLUMN "productsServices",
DROP COLUMN "ragIngested",
DROP COLUMN "ragIngestedAt",
DROP COLUMN "scrapedMarkdown",
DROP COLUMN "scrapedWebsiteUrl",
DROP COLUMN "targetAudience",
DROP COLUMN "watermarkPosition",
DROP COLUMN "workingHours";

-- DropTable
DROP TABLE "BusinessProfileFaq";

-- DropTable
DROP TABLE "BusinessProfileKnowledgeSection";
