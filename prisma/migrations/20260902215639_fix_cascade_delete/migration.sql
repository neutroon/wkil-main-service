-- DropForeignKey
ALTER TABLE "public"."BusinessProfile" DROP CONSTRAINT "BusinessProfile_workspaceId_fkey";

-- AlterTable
ALTER TABLE "public"."OrderEvent" ALTER COLUMN "rawPayloadRetentionUntil" SET DEFAULT CURRENT_TIMESTAMP + INTERVAL '30 days';

-- AddForeignKey
ALTER TABLE "public"."BusinessProfile" ADD CONSTRAINT "BusinessProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
