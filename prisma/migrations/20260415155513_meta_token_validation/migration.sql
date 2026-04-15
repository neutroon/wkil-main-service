-- AlterTable
ALTER TABLE "public"."FacebookAccount" ADD COLUMN     "isTokenValid" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastValidatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."FacebookPage" ADD COLUMN     "isTokenValid" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastValidatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "public"."WhatsAppAccount" ADD COLUMN     "isTokenValid" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "lastValidatedAt" TIMESTAMP(3);
