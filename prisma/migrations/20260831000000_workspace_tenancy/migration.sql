-- AlterTable
ALTER TABLE "public"."BusinessProfile" ADD COLUMN     "setupCompletedAt" TIMESTAMP(3),
ADD COLUMN     "workspaceId" INTEGER;

-- CreateTable
CREATE TABLE "public"."Workspace" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WorkspaceMember" (
    "id" SERIAL NOT NULL,
    "workspaceId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "public"."WorkspaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "public"."WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_workspaceId_key" ON "public"."BusinessProfile"("workspaceId");

-- AddForeignKey
ALTER TABLE "public"."BusinessProfile" ADD CONSTRAINT "BusinessProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one workspace per existing business profile (id = profile id),
-- creator becomes owner, existing profiles count as onboarded.
INSERT INTO "Workspace" ("id", "name", "createdAt")
SELECT "id", 'Business ' || "id"::text, "createdAt" FROM "BusinessProfile";

UPDATE "BusinessProfile" SET "workspaceId" = "id";

ALTER TABLE "public"."BusinessProfile" ALTER COLUMN "workspaceId" SET NOT NULL;

INSERT INTO "WorkspaceMember" ("workspaceId", "userId", "role", "isActive", "createdAt")
SELECT "id", "userId", 'owner', true, "createdAt" FROM "BusinessProfile";

UPDATE "BusinessProfile" SET "setupCompletedAt" = "createdAt" WHERE "setupCompletedAt" IS NULL;

-- Sync sequences after explicit-id inserts.
SELECT setval(pg_get_serial_sequence('"Workspace"', 'id'), (SELECT COALESCE(MAX("id"), 1) FROM "Workspace"));
SELECT setval(pg_get_serial_sequence('"WorkspaceMember"', 'id'), (SELECT COALESCE(MAX("id"), 1) FROM "WorkspaceMember"));
