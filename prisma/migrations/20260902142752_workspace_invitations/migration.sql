/*
  Warnings:

  - You are about to drop the column `label` on the `WidgetInstall` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."Customer" ALTER COLUMN "updatedAt" DROP DEFAULT,
ALTER COLUMN "resolvedAt" SET DATA TYPE TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."CustomerExternalIdentity" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "public"."OrderEvent" ALTER COLUMN "rawPayloadRetentionUntil" SET DEFAULT CURRENT_TIMESTAMP + INTERVAL '30 days';

-- AlterTable
ALTER TABLE "public"."WidgetInstall" DROP COLUMN "label",
ALTER COLUMN "identitySecret" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "public"."CustomerExternalIdentity_businessProfileId_channel_externalId_k" RENAME TO "CustomerExternalIdentity_businessProfileId_channel_external_key";
